// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from 'vscode';

import * as path from 'path';
import { ChildProcess } from 'child_process';

const { spawn } = require('node:child_process');
const net = require('node:net');
const assert = require('node:assert');

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

// Decorations
var processingProofColor = "#c3f8d357";
var processedProofColor = "#00f04857";
var processedErrorProofColor = "#f0000057";
var decorationProcessingProof = vscode.window.createTextEditorDecorationType({backgroundColor : processingProofColor});
var decorationProcessedProof = vscode.window.createTextEditorDecorationType({backgroundColor : processedProofColor});
var decorationErrorProof = vscode.window.createTextEditorDecorationType({backgroundColor : processedErrorProofColor});

// Position of the beginning of the document, of the last point requested to be processed, and of the last point where the proof was processed. TODO wrap this in an object or something
const startDocumentPosition = new vscode.Position(0, 0);
var endProofPosition : vscode.Position | undefined = undefined;
var lastProcessedPointProofPosition : vscode.Position | undefined = undefined;
var waitingForProofProcessing : boolean = false; // === (lastProcessedPointProofPosition !== endProofPosition)
var currentEditor : vscode.TextEditor | undefined = undefined;

/// Sends [msg] to LSP server
function send(msg : string) {
	if (lsp_server.stdin === null) {
		console.log("LSP server: stdin undefined while sending");
	} else {
		lsp_server.stdin.write(`${msg}\n`);
	}
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
		if (objRcvd.method === "vsquirrel/squirrelProofOutput" && proofPanel !== undefined) {
			// Display proof state/message from squirrel on proof panel
			if(objRcvd.kind === "error") {
				// Display error messages from squirrel on proof panel
				proofStateErrors = squirrelAsHTML(objRcvd.payload);
				updateProofStateInWebview(proofPanel);
				// Highlight the command that triggered the error
				if (currentEditor !== undefined && lastProcessedPointProofPosition !== undefined && endProofPosition !== undefined) {
					currentEditor.setDecorations(decorationErrorProof, [new vscode.Range(lastProcessedPointProofPosition, endProofPosition)]);
				}
			} else {
				proofStateErrors = undefined;
				proofStateMain = squirrelAsHTML(objRcvd.payload);
				updateProofStateInWebview(proofPanel);
				if (currentEditor !== undefined && lastProcessedPointProofPosition !== undefined && endProofPosition !== undefined) {
					// Remove previous processing highlighting and error highlighting, if any; and highlight the command that was just processed
					currentEditor.setDecorations(decorationErrorProof, []);
					currentEditor.setDecorations(decorationProcessingProof, []);
					currentEditor.setDecorations(decorationProcessedProof, [new vscode.Range(startDocumentPosition, endProofPosition)]);
					// Update positions
					lastProcessedPointProofPosition = endProofPosition;
					waitingForProofProcessing = false;
				}
			}
		}
	}

}

/// Receives data from LSP server TODO
// function LSPRecv() {
// 	if (lsp_server.stdout === null) {
// 		console.error("LSP server: stdout undefined while sending");
// 	} else {
// 		// Reading header
// 		lsp_server.stdout.read()
// 		// Reading payload
// 		if (DEBUG_MODE) {
// 			console.log(`==== Received ====\n${msg_with_header}\n============`);
// 		}
// 	}
// }

/// Returns next valid position after [from] in [doc]. It may add a line if the position is at the end of a line.
/// Returns [undefined] if [from] is the last valid position in [doc].
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

// Global state maintaining what's to be displayed on the proof panel.
var proofStateMain : string;
var proofStateErrors : string | undefined = undefined; // Must be reset to [undefined] at each new command.
/// Returns proof states in an HTML page, adapted to display in a webview.
function updateProofStateInWebview(panel : vscode.WebviewPanel) : void {
	var HTMLProofStateErrors = "";
	if (proofStateErrors !== undefined) {
		HTMLProofStateErrors = `<p id="errors"> ${proofStateErrors} </p>`;
	}
	panel.webview.html = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Squirrel Proof</title>
</head>
<body>
    <p id="main">
			${proofStateMain}
		</p>
		${HTMLProofStateErrors}
</body>
</html>`;
}

// Side panel. [undefined] means the proof panel does not exist at the time.
var proofPanel : vscode.WebviewPanel | undefined = undefined;

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

export function activate(context: vscode.ExtensionContext) {
	console.log('VSquirrel is now active.');
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
			// TODO read bit by bit as is already done for stdout.
			console.error(`==stderr==\n${data}\n==end stderr==`);
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

	// Command to start a proof on a given file (TODO for now, it is actually agnostic to the files).
	// TODO authorize to use nextProof, etc only on file where the proof was started.
	const startProofCmd = vscode.commands.registerTextEditorCommand('vsquirrel.startProof',
		(textEditor: vscode.TextEditor, edit: vscode.TextEditorEdit, args: any[]) => {
			if (!(endProofPosition === undefined && lastProcessedPointProofPosition === undefined)) {
				vscode.window.showErrorMessage("VSquirrel: Proof already started.");
			} else {
				// Setting position of last processed point in the proof at the beginning of the file.
				endProofPosition = new vscode.Position(0, 0);
				lastProcessedPointProofPosition = new vscode.Position(0, 0);
				waitingForProofProcessing = false;
				// Sending path to squirrel to the LSP server
				LSPSend({method:"vsquirrel/startProof", pathToSquirrel: squirrelPath}, true);
				// Creating panel where the goals are displayed
				proofPanel = vscode.window.createWebviewPanel(
					"squirrel-prover-proof",
					`Squirrel ${textEditor.document.fileName}`,
					{preserveFocus: true, viewColumn: vscode.ViewColumn.Beside}
				);
			}
		}
	);
	
	// Process proof until next [.]
	const nextProofCmd = vscode.commands.registerTextEditorCommand('vsquirrel.nextProof',
		(textEditor: vscode.TextEditor, edit: vscode.TextEditorEdit, args: any[]) => {
			if (endProofPosition === undefined || lastProcessedPointProofPosition === undefined) {
				vscode.window.showErrorMessage("VSquirrel: You must first start the proof.");
			} else if (waitingForProofProcessing) {
				// TODO authorizing the processing of several command may lead to errors, for now let's keep that and see if we can lift the restriction in the future. 
				vscode.window.showErrorMessage("VSquirrel: Wait for last commant to be processed.");
			} else {
				const nextDotPosition : vscode.Position | undefined = findNextDot(textEditor.document, lastProcessedPointProofPosition);
				if (nextDotPosition === undefined) {
					vscode.window.showErrorMessage("VSquirrel: No dot to get the proof to in the remaining of the document.");
				} else {
					// Make [textEditor] available to event function of LSP server's subprocess
					currentEditor = textEditor;
					// Send proof to process to LSP server
					const bufferProof = textEditor.document.getText(new vscode.Range(lastProcessedPointProofPosition, nextDotPosition));
					LSPSend({method:"vsquirrel/nextProof", proofCommand: bufferProof}, true);
					// Update last processed point in the proof
					endProofPosition = new vscode.Position(nextDotPosition.line, nextDotPosition.character);
					// Update highlighting of proof in process
					textEditor.selection = new vscode.Selection(nextDotPosition, nextDotPosition);
					textEditor.setDecorations(decorationProcessingProof, [new vscode.Range(lastProcessedPointProofPosition, endProofPosition)]);
				}
			}
		}
	);

	context.subscriptions.push(killServer);
	context.subscriptions.push(nextProofCmd);
	context.subscriptions.push(startProofCmd);
}

// This method is called when your extension is deactivated
export function deactivate() {
	lsp_server.kill();
}
