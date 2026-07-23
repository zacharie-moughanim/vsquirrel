// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from 'vscode';

import * as path from 'path';
import { ChildProcess } from 'child_process';
import { text } from 'stream/consumers';
import { start } from 'repl';

const { spawn } = require('node:child_process');
const net = require('node:net');
const assert = require('node:assert');

// TODO bundle extension
var ConvertANSIToHTML = require('ansi-to-html');

var convertANSIToHTML = new ConvertANSIToHTML();

// Whether to display debug messages
const DEBUG_MODE : boolean = true;

// Console channel for debug messages
let debugChannel : vscode.OutputChannel;
var client : any;

// Paths to required software
const configPythonPath : string | undefined = vscode.workspace.getConfiguration('SquirrelProver').get("lsp.pythonInterpreterPath");
const configSquirrelPath : string | undefined = vscode.workspace.getConfiguration('SquirrelProver').get("squirrelPath");

// The LSP server subprocess
var lsp_server : ChildProcess;
var buf_stdout : string = "";
var buf_stderr : string = "";

/// PROOFS STATE

// Position of the beginning of the document, of the last point requested to be processed, and of the last point where the proof was processed.
const startDocumentPosition = new vscode.Position(0, 0);

// Decorations
var processingProofColor = "#c3f8d357";
var processedProofColor = "#00f04857";
var processedErrorProofColor = "#f0000057";

class SquirrelDocumentProofState {
	// Panels: editor & proof panel
	editor : vscode.TextEditor;
	proofPanel : vscode.WebviewPanel;
	// Global state maintaining what's to be displayed on the proof panel.
	proofStateMain : string;
	proofStateErrors : string | undefined; // Must be reset to [undefined] at each new command.
	// Positions
	endProofPosition : vscode.Position;
	endProofPositionHistoric : vscode.Position[];
	lastProcessedProofPosition : vscode.Position;
	lastProcessingProofPosition : vscode.Position | undefined;
	lastErrorProofPosition : vscode.Position | undefined;
	waitingForProofProcessing : boolean;
	// Decorations
	decorationProcessingProof : vscode.TextEditorDecorationType;
	decorationProcessedProof : vscode.TextEditorDecorationType;
	decorationErrorProof : vscode.TextEditorDecorationType;
	processedRangeHistoric : (vscode.Range | null)[];

	closing : boolean;

	constructor(
		editor : vscode.TextEditor,
		proofPanel : vscode.WebviewPanel,
		endPos : vscode.Position = new vscode.Position(0, 0),
		lastProcessedPos = new vscode.Position(0, 0),
		waitingForProofProcessing = false,
		decorationProcessingProof = vscode.window.createTextEditorDecorationType({backgroundColor : processingProofColor, rangeBehavior : vscode.DecorationRangeBehavior.ClosedClosed}),
		decorationProcessedProof = vscode.window.createTextEditorDecorationType({backgroundColor : processedProofColor, rangeBehavior : vscode.DecorationRangeBehavior.ClosedClosed}),
		decorationErrorProof = vscode.window.createTextEditorDecorationType({backgroundColor : processedErrorProofColor, rangeBehavior : vscode.DecorationRangeBehavior.ClosedClosed}),
		processedRangeHistoric : (vscode.Range | null)[] = []
	) {
		this.editor = editor;
		this.proofPanel = proofPanel;

		this.proofStateMain = "";
		this.proofStateErrors = undefined;

		this.endProofPosition = endPos;
		this.lastProcessedProofPosition = endPos;
		this.endProofPosition = lastProcessedPos;
		this.waitingForProofProcessing = waitingForProofProcessing;
		this.endProofPositionHistoric = [this.endProofPosition];

		this.decorationProcessingProof = decorationProcessingProof;
		this.decorationProcessedProof = decorationProcessedProof;
		this.decorationErrorProof = decorationErrorProof;
		this.processedRangeHistoric = processedRangeHistoric;

		this.closing = false;
	}

	public updateEndProofPosition(pos : vscode.Position) {
		this.endProofPositionHistoric.push(pos);
		this.endProofPosition = pos;
	}

	public undoEndProofPosition() {
		if (this.endProofPositionHistoric.length <= 2) {
			vscode.window.showErrorMessage("Nothing to undo (position).");
		} else {
			this.endProofPositionHistoric.pop();
			const posToRestore = this.endProofPositionHistoric.at(-1);
			if (posToRestore === undefined) {
				vscode.window.showErrorMessage("panic.");
			} else {
				this.endProofPosition = posToRestore; // Correct even if .at returns [undefined]
			}
		}
	}

	/** Updates proof decorations.
	 * @param processingRange: [undefined] means this decoration is not modified; [null] means it's reset (nothing is now decorated with decorationProcessingProof); if it's a range, [decorationProcessingProof] will now decorate this range.
	 * @param processedRange: similar.
	 * @param errorRange: similar.
	 */
	public updateProofDecorations(processingRange : vscode.Range | undefined | null, processedRange : vscode.Range | undefined | null, errorRange : vscode.Range | undefined | null) {
		if (processingRange !== undefined) {
			let ranges : vscode.Range[] = [];
			this.lastProcessingProofPosition = undefined;
			if (processingRange !== null) {
				ranges = [processingRange];
				this.lastProcessingProofPosition = processingRange.end;
			}
			this.editor.setDecorations(this.decorationProcessingProof, ranges);
		}
		if (processedRange !== undefined) {
			let ranges : vscode.Range[] = [];
			if (processedRange !== null) {
				ranges = [new vscode.Range(processedRange.start, new vscode.Position(processedRange.end.line, processedRange.end.character))];
			}
			this.processedRangeHistoric.push(processedRange);
			this.editor.setDecorations(this.decorationProcessedProof, ranges);
		}
		if (errorRange !== undefined) {
			let ranges : vscode.Range[] = [];
			this.lastErrorProofPosition = undefined;
			if (errorRange !== null) {
				ranges = [errorRange];
				this.lastErrorProofPosition = errorRange.end;
			}
			this.editor.setDecorations(this.decorationErrorProof, ranges);
		}
	}

	public refreshHighlights() {
		vscode.window.showInformationMessage(`start pos: l.${startDocumentPosition.line} c.${startDocumentPosition.character}\nlast pos: l.${this.lastProcessedProofPosition.line} c.${this.lastProcessedProofPosition.character}`);
		this.editor.setDecorations(this.decorationProcessedProof, [new vscode.Range(startDocumentPosition, this.lastProcessedProofPosition)]);
		vscode.window.showInformationMessage("DONE!");
		if (this.lastProcessingProofPosition !== undefined) {
			this.editor.setDecorations(this.decorationProcessingProof, [new vscode.Range(this.lastProcessedProofPosition, this.lastProcessingProofPosition)]);
		}
		if (this.lastErrorProofPosition !== undefined) {
			this.editor.setDecorations(this.decorationErrorProof, [new vscode.Range(this.lastProcessedProofPosition, this.lastErrorProofPosition)]);
		}
	}

	public undoProcessedDecoration() {
		if (this.processedRangeHistoric.length === 0) {
			vscode.window.showErrorMessage("Nothing to undo (decorations)");
		} else {
			this.processedRangeHistoric.pop();
			const prevDecoration = this.processedRangeHistoric.at(-1);
			if (prevDecoration === undefined) {
				// We undo'd until the very beginning of the proof.
				this.editor.setDecorations(this.decorationProcessedProof, []);
			} else {
				if (prevDecoration === null) {
					this.editor.setDecorations(this.decorationProcessedProof, []);
				} else {
					this.editor.setDecorations(this.decorationProcessedProof, [prevDecoration]);
				}
			}
		}
	}

	/// Returns proof states in an HTML page, adapted to display in a webview.
	public updateProofStateInWebview() : void {
		let HTMLProofStateErrors = "";
		let errorStyle = "";
		// panel.webview.options.
		const mainStyle = `#main {
			border-bottom: .5em solid;
			height: 50%;
			overflow: scroll;
		}`;
		if (this.proofStateErrors !== undefined) {
			HTMLProofStateErrors = `<div id="errors"> ${this.proofStateErrors} </div>`;
			errorStyle = `#error {
			height: 50%;
				overflow: scroll;
			}`;	
		}
		this.proofPanel.webview.html = `<!DOCTYPE html>
	<html lang="en">
	<head>
			<meta charset="UTF-8">
			<meta name="viewport" content="width=device-width, initial-scale=1.0">
			<style>
			${mainStyle}
			${errorStyle}
			#column {
				height: 100vh;
			}
			</style>
			<title>Squirrel Proof</title>
	</head>
	<body>
		<div id="column">
			<div id="main">
				${this.proofStateMain}
			</div>
			${HTMLProofStateErrors}
		</div>
	</body>
	</html>`;
	}

}

var proofStates : Map<string, SquirrelDocumentProofState> = new Map();

/// Proof actual evaluation (interacting with LSP)

/** [evaluateProofToPoint] evaluates proof of */
function evaluateProofToPoint(document : vscode.TextDocument, documentState : SquirrelDocumentProofState, point : vscode.Position) {
	console.error("TODO evaluateProofToPoint");
	vscode.window.showErrorMessage("TODO evaluateProofToPoint");
}

var idx : number = 0;
/// Sends [msg] to LSP server, computing header on [data]
function LSPSend(obj : object, withUniqueId : boolean = false) {
	if (lsp_server.stdin === null) {
		console.error("LSP server: stdin undefined while sending");
	} else {
		if (withUniqueId) {
			var obj2 : any = obj; // TODO see if there's no better option
			obj2.id = idx;
			idx += 1;
		}
		const data : string = JSON.stringify(obj2);
		const msg_with_header : string = `Content-Length: ${data.length}\r\n\r\n${data}`;
		lsp_server.stdin.write(`${msg_with_header}`);
		if (DEBUG_MODE) {
			console.log(`==== Sent ====\n${msg_with_header}\n============`);
		}
	}
}

/** Manage [data] received on stdout, if [data] represent a single JSON object. */
function LSPRecvStdout(data : string) : void {
	const objRcvd = JSON.parse(data);
	if (Object.hasOwn(objRcvd, "method")) {
		if (objRcvd.method === "vsquirrel/squirrelProofOutput") {
			if(!(Object.hasOwn(objRcvd, "kind"))) {
				vscode.window.showErrorMessage("Received LSP message without excepted field [kind].");
			} else {
				if(!(Object.hasOwn(objRcvd, "documentId"))) {
					vscode.window.showErrorMessage("Received LSP message without excepted field [kind].");
				} else {
					let proofState = proofStates.get(objRcvd.documentId);
					if (proofState === undefined) {
						vscode.window.showErrorMessage("Panic: LSP server mentions a closed or nonexitstent file.");
					} else {
						if(objRcvd.kind === "error") {
							// Highlight the command that triggered the error
							// TODO actually look for specific document
							proofState.updateProofDecorations(undefined, undefined, new vscode.Range(proofState.lastProcessedProofPosition, proofState.endProofPosition));
							// Display error messages from squirrel on proof panel
							proofState.proofStateErrors = squirrelAsHTML(objRcvd.payload);
							proofState.updateProofStateInWebview();
						} else {
							proofState.proofStateErrors = undefined;
							proofState.proofStateMain = squirrelAsHTML(objRcvd.payload);
							proofState.updateProofStateInWebview();
							// Remove previous processing highlighting and error highlighting, if any and highlight the command that was just processed
							proofState.updateProofDecorations(null, new vscode.Range(startDocumentPosition, proofState.endProofPosition), null);
							// Update positions
							proofState.lastProcessedProofPosition = proofState.endProofPosition;
							proofState.waitingForProofProcessing = false;
						}
					}
				}
			}
		}
	}
}

/** Manage [data] received on stderr, if [data] represent a single JSON object. */
function LSPRecvStderr(data : string) : void {
	const objRcvd = JSON.parse(data);
	if (Object.hasOwn(objRcvd, "method")) {
		if (objRcvd.method === "vsquirrel/lsperror") {
			vscode.window.showWarningMessage(`VSquirrel LSP error message: ${objRcvd.data}`);
		} else if (objRcvd.method === "vsquirrel/debug") {
			vscode.window.showInformationMessage(`VSquirrel LSP Error message: ${objRcvd.data}`);
		} else {
			vscode.window.showErrorMessage(`VSquirrel: LSP server stderr: ${data}`);
		}
	} else {
		vscode.window.showErrorMessage(`VSquirrel: LSP server stderr: ${data}`);
	}
}

/** Returns next valid position after [from] in [doc]. It may add a line if the position is at the end of a line.
 *  Returns [undefined] if [from] is the last valid position in [doc].  */
function nextCharacterPosition(doc : vscode.TextDocument, from : vscode.Position) : vscode.Position | undefined {
	const nextPosOnLine = from.translate({characterDelta: 1});
	const validNextPosOnLine = doc.validatePosition(nextPosOnLine);
	if (validNextPosOnLine.character === from.character + 1) {
		return nextPosOnLine;
	} else {
		const nextPos =  new vscode.Position(from.line + 1, 0);
		const validNextPos = doc.validatePosition(nextPos);
		if (validNextPos.character === nextPos.character && validNextPos.line === nextPos.line) {
			return nextPos;
		} else {
			return undefined;
		}
	}
}

/** Convert Squirrel's output to text suitable for HTML */
function squirrelAsHTML(body : string) : string {
	return convertANSIToHTML.toHtml(body).replaceAll("\n", "<br/>");
}

/** Find position of next dot in the [doc] from the position [from], ignoring comments e.g. on [(* a sentence. *) Proof.], it returns the position of the second dot. */
function findNextDot(doc : vscode.TextDocument, from : vscode.Position) : vscode.Position | undefined {
	var prevChar : string;
	var curChar : string = "";
	var curPos : vscode.Position = from;
	var nextPos : vscode.Position | undefined;
	var lastCharWasHalfOfACommentBracket : boolean = false;
	var withinComment : boolean = false;
	do {
		nextPos = nextCharacterPosition(doc, curPos);
		if (nextPos === undefined) {
			return undefined;
		}
		prevChar = curChar;
		curChar = doc.getText(new vscode.Range(curPos, nextPos));
		curPos = nextPos;
		if (withinComment) {
			if (prevChar === "*" && curChar === ")") {
				withinComment = false;
			}
		} else {
			if (prevChar === "(" && curChar === "*") {
				withinComment = true;
			}
		}
	} while (!(curChar === '.' && !withinComment));
	return nextPos;
}

function closeProof(documentId : string, disposeWebviewPanel : boolean) : void {
	// Closing is used to avoir loop in case closeProof --triggers--> dispose webview --triggers--> closeProof ...
	let proofState = proofStates.get(documentId);
	if (proofState === undefined) {
		vscode.window.showErrorMessage("VSquirrel: Proof is not started.");
	} else if (!proofState.closing) {
		proofState.closing = true;
		if (disposeWebviewPanel) {
			proofState.proofPanel.dispose();
		}
		// Removing proof state from client
		proofStates.delete(documentId);
		// Removing decorations
		proofState.decorationErrorProof.dispose();
		proofState.decorationProcessedProof.dispose();
		proofState.decorationProcessingProof.dispose();
		// Telling the server to close proof
		LSPSend({method:"vsquirrel/closeProof", documentId: documentId}, true);
	}
}

export function activate(context: vscode.ExtensionContext) {
	console.log('VSquirrel is now active.');
	vscode.window.showInformationMessage('VSquirrel is now active.');
	debugChannel = vscode.window.createOutputChannel("Squirrel Debug", {log : true});

	// Finding paths to python and squirrel
	var pythonPath : string;
	var squirrelPath : string;
	if (configPythonPath !== undefined) {
		pythonPath = configPythonPath;
	} else {
		pythonPath = "python";
	}
	if (configSquirrelPath !== undefined) {
		squirrelPath = configSquirrelPath;
	} else {
		squirrelPath = "python";
	}
	// Path to LSP server
	let serverStartCLOptions : string[] = ["squirrel_server.py"];
	const server_workdir : string = context.asAbsolutePath(path.join('server', 'pysquirrel-prover-lsp'));

	console.log(`${pythonPath} ${serverStartCLOptions}`);

	// Spawning LSP Server
	lsp_server = spawn(pythonPath, serverStartCLOptions, { "cwd": server_workdir });

	if (lsp_server.stdout !== null) {
		lsp_server.stdout.setEncoding("utf8");
		lsp_server.stdout.on('data', (data : string) => {
			buf_stdout += data;
			console.log(`==stdout==\n${data}\n==end stdendout==`);
			debugChannel.appendLine(data); // .toString() not sure it's useful...
			// Parsing buffer. It may contain several chunks of the form HEADER\r\nAJSONOBJECT. We read all such chunks and pass them to LSPRecvStdout
			let stillDataToParse : boolean = true;
			while (stillDataToParse) {
				stillDataToParse = false;
				let contentLength : number | undefined = undefined;
				const contentlengthFieldTitle = "Content-Length:";
				const lines_stdout = buf_stdout.split("\n");
				let readingHeader : boolean = true;
				let i = 0;
				for (i = 0; i < lines_stdout.length && readingHeader; ++i) {
					let line = lines_stdout[i];
					if (line.trim() === "") {
						readingHeader = false;
					}
					if(line.substring(0, contentlengthFieldTitle.length).toLowerCase() === contentlengthFieldTitle.toLowerCase()) {
						const splitLine = line.split(":");
						if (splitLine.length >= 2) { // Otherwise, we wait for more output from LSP server
							contentLength = parseInt(splitLine[1]);
						}
					}
				}
				if (contentLength !== undefined) {
					const rest : string = lines_stdout.filter((v, j) => j >= i).join("\n");
					if (rest.length >= contentLength) {
						stillDataToParse = true;
						LSPRecvStdout(rest.substring(0, contentLength));
						buf_stdout = rest.substring(contentLength);
					}
				}
			}
		});
	} else {
		console.error("LSP server: stdout undefined");
	}

	if (lsp_server.stderr !== null) {
		lsp_server.stderr.setEncoding("utf8");
		lsp_server.stderr.on('data', (data : string) => {
			buf_stderr += data;
			console.error(`==stderr==\n${data}\n==end stderr==`);
			debugChannel.appendLine(data); // .toString() not sure it's useful...
			// Parsing buffer. It may contain several chunks of the form HEADER\r\nAJSONOBJECT. We read all such chunks and pass them to LSPRecvStdout
			let stillDataToParse : boolean = true;
			while (stillDataToParse) {
				stillDataToParse = false;
				let contentLength : number | undefined = undefined;
				const contentlengthFieldTitle = "Content-Length:";
				const lines_stderr = buf_stderr.split("\n");
				let readingHeader : boolean = true;
				let i = 0;
				for (i = 0; i < lines_stderr.length && readingHeader; ++i) {
					let line = lines_stderr[i];
					if (line.trim() === "") {
						readingHeader = false;
					}
					if(line.substring(0, contentlengthFieldTitle.length).toLowerCase() === contentlengthFieldTitle.toLowerCase()) {
						const splitLine = line.split(":");
						if (splitLine.length >= 2) { // Otherwise, we wait for more output from LSP server
							contentLength = parseInt(splitLine[1]);
						}
					}
				}
				if (contentLength !== undefined) {
					const rest : string = lines_stderr.filter((v, j) => j >= i).join("\n");
					if (rest.length >= contentLength) {
						stillDataToParse = true;
						LSPRecvStderr(rest.substring(0, contentLength));
						buf_stderr = rest.substring(contentLength);
					}
				}
			}
		});
	} else {
		console.error("LSP server: stderr undefined");
	}

	lsp_server.on('close', (code : number, signal : string) => {
		if (signal !== null) {
			vscode.window.showErrorMessage(`VSquirrel: LSP server exited with code ${code} and signal ${signal}`);
			console.log(`LSP server exited with code ${code} and signal ${signal}`);
		} else {
			vscode.window.showErrorMessage(`VSquirrel: LSP server exited with code ${code}`);
			console.log(`LSP server exited with code ${code}`);
		}
	});

	lsp_server.on('error', (err : Error) => {
		vscode.window.showErrorMessage(`VSquirrel: LSP server error: ${err}`);
		console.error(`LSP server error: ${err}`);
	});

	// For debugging, kill LSP server
	const killServer = vscode.commands.registerCommand('vsquirrel.killServer', () => {
		lsp_server.kill();
	});

	// Command to start a proof on a given file
	const startProofCmd = vscode.commands.registerTextEditorCommand('vsquirrel.startProof',
		(textEditor: vscode.TextEditor, edit: vscode.TextEditorEdit, args: any[]) => {
			const prevProofState : SquirrelDocumentProofState | undefined = proofStates.get(textEditor.document.fileName);
			if (prevProofState !== undefined) {
				vscode.window.showErrorMessage("VSquirrel: Proof already started.");
			} else {
					// Creating panel where the goals are displayed
				let proofPanel = vscode.window.createWebviewPanel(
					"squirrel-prover-proof",
					`Squirrel ${textEditor.document.fileName}`,
					{preserveFocus: true, viewColumn: vscode.ViewColumn.Beside}
				);
				// Closing proof when the proof panel is closed
				proofPanel.onDidDispose(
					() => {
						closeProof(textEditor.document.fileName, false);
					},
					null,
					context.subscriptions
				);
				vscode.window.onDidChangeActiveTextEditor((activeEditor : vscode.TextEditor | undefined) => {
					if (activeEditor !== undefined) {
						let proofState = proofStates.get(activeEditor.document.fileName);
						if (proofState !== undefined) {
							proofState.proofPanel.reveal();
						}
					}
 				});
				// Update editors registered in [proofState] on tab change, and refresh highlights when a document is made visible again.
				vscode.window.onDidChangeVisibleTextEditors((editors : readonly vscode.TextEditor[]) => {
					for (let editor of editors) {
						let proofState = proofStates.get(editor.document.fileName);
						if (proofState !== undefined) {
							proofState.editor = editor;
							proofState.refreshHighlights();
						}
					}
				});
				// Adding an entry to proof states for this file and information to the LSP server
				proofStates.set(textEditor.document.fileName, new SquirrelDocumentProofState(textEditor, proofPanel));
				LSPSend({method:"vsquirrel/startProof", pathToSquirrel: squirrelPath, documentId: textEditor.document.fileName}, true);

			}
		}
	);

	// Command to close a proof on a given file
	const closeProofCmd = vscode.commands.registerTextEditorCommand('vsquirrel.closeProof',
		(textEditor: vscode.TextEditor, edit: vscode.TextEditorEdit, args: any[]) => {
			closeProof(textEditor.document.fileName, true);
		}
	);
	
	// Process proof until next [.]
	const nextProofCmd = vscode.commands.registerTextEditorCommand('vsquirrel.nextProof',
		(textEditor: vscode.TextEditor, edit: vscode.TextEditorEdit, args: any[]) => {
			const proofState : SquirrelDocumentProofState | undefined = proofStates.get(textEditor.document.fileName);
			if (proofState === undefined) {
				vscode.window.showErrorMessage("VSquirrel: You must first start the proof.");
			} else if (proofState.waitingForProofProcessing) {
				// TODO authorizing the processing of several command may lead to errors, for now let's keep that and see if we can lift the restriction in the future. 
				vscode.window.showErrorMessage("VSquirrel: Wait for last command to be processed.");
			} else {
				const nextDotPosition : vscode.Position | undefined = findNextDot(textEditor.document, proofState.lastProcessedProofPosition);
				if (nextDotPosition === undefined) {
					vscode.window.showErrorMessage("VSquirrel: No dot to get the proof to in the remaining of the document.");
				} else {
					// Send proof to process to LSP server
					const bufferProof = textEditor.document.getText(new vscode.Range(proofState.lastProcessedProofPosition, nextDotPosition));
					LSPSend({method:"vsquirrel/proofCommand", proofCommand: bufferProof, documentId: textEditor.document.fileName}, true);
					// Update last processed point in the proof
					proofState.updateEndProofPosition(new vscode.Position(nextDotPosition.line, nextDotPosition.character));
					// Move cursor to the end of processing proof, and scroll if needed
					textEditor.selection = new vscode.Selection(nextDotPosition, nextDotPosition);
					textEditor.revealRange(new vscode.Range(nextDotPosition, nextDotPosition));
					// Update highlighting of proof in process
					proofState.updateProofDecorations(new vscode.Range(proofState.lastProcessedProofPosition, proofState.endProofPosition), undefined, undefined);
				}
			}
		}
	);

	// Undo last proof command, if any.
	const undoProofCmd = vscode.commands.registerTextEditorCommand('vsquirrel.undoProof',
		(textEditor: vscode.TextEditor, edit: vscode.TextEditorEdit, args: any[]) => {
			const proofState : SquirrelDocumentProofState | undefined = proofStates.get(textEditor.document.fileName);
			if (proofState === undefined) {
				vscode.window.showErrorMessage("VSquirrel: You must first start the proof.");
			} else if (proofState.waitingForProofProcessing) {
				// TODO authorizing the processing of several command may lead to errors, for now let's keep that and see if we can lift the restriction in the future. 
				vscode.window.showErrorMessage("VSquirrel: Wait for last command to be processed.");
			} else {
				if (false /* "a last point exists" */) {
					vscode.window.showErrorMessage("VSquirrel: No proof command to undo.");
				} else {
					// Send proof to process to LSP server
					LSPSend({method:"vsquirrel/proofCommand", proofCommand: "undo 1.", documentId: textEditor.document.fileName}, true);
					// Update last processed point in the proof
					if (proofState.endProofPositionHistoric.length === 0) {
						vscode.window.showErrorMessage("No proof to undo (end position).");
					} else {
						proofState.undoEndProofPosition();
					}
					// Move cursor to new end of proof
					textEditor.selection = new vscode.Selection(proofState.endProofPosition, proofState.endProofPosition);
					// Update highlighting of proof in process
					proofState.undoProcessedDecoration();
				}
			}
		}
	);
	
	// Process commands up to the first dot preceding current cursor's position.
	const goToProofCmd = vscode.commands.registerTextEditorCommand('vsquirrel.goToProof',
		(textEditor: vscode.TextEditor, edit: vscode.TextEditorEdit, args: any[]) => {
			// BEWARE squirrel's output is weird if in a single prompt there are several dots.
			// TODO
			vscode.window.showErrorMessage("TODO not implemented yet.");
		}
	);

	vscode.workspace.onDidCloseTextDocument((doc : vscode.TextDocument) => {
		// Reset proof if a proof bas started on [doc]
	});

	// Undoing proof when modifying processed proof.
	vscode.workspace.onDidChangeTextDocument(
		(event: vscode.TextDocumentChangeEvent) => {
			const proofState : SquirrelDocumentProofState | undefined = proofStates.get(event.document.fileName);
			if (proofState !== undefined) {
				let minimalModifiedPoint : vscode.Position | undefined = undefined;
				for (let contentChange of event.contentChanges) {
					if (minimalModifiedPoint === undefined) {
						minimalModifiedPoint = contentChange.range.start;
					} else {
						if (minimalModifiedPoint.isAfter(contentChange.range.start)) {
							minimalModifiedPoint = contentChange.range.start;
						}
					}
				}
				if (minimalModifiedPoint !== undefined && proofState.endProofPosition !== undefined) {
					if (minimalModifiedPoint.isBefore(proofState.endProofPosition)) {
						event.document.uri; // Will be the [id] of the document 
						evaluateProofToPoint(event.document, proofState, minimalModifiedPoint);
						vscode.window.showInformationMessage("Modified before end of proof! TODO evaluate to point");
					}
				}
				vscode.window.showInformationMessage("CHANGED");
			}
		},
	);

	context.subscriptions.push(startProofCmd);
	context.subscriptions.push(closeProofCmd);
	context.subscriptions.push(nextProofCmd);
	context.subscriptions.push(undoProofCmd);
	context.subscriptions.push(killServer);
}

// This method is called when your extension is deactivated
export function deactivate() {
	lsp_server.kill();
}
