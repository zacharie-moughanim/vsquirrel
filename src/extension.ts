import * as vscode from 'vscode';

import * as path from 'path';
import { ChildProcess } from 'child_process';
import { debug } from 'console';

import { SquirrelDocumentProofState } from './proofState';

const { spawn } = require('node:child_process');

var ConvertANSIToHTML = require('ansi-to-html');

var foreground_webview_color : string = "#FFF";

var convertANSIToHTML = new ConvertANSIToHTML({
	fg: foreground_webview_color,
	newline: true,
	escapeXML: true
});

// Whether to display debug messages
const DEBUG_MODE : boolean = false;

// Console channel for debug messages
let debugChannel : vscode.OutputChannel;

// The LSP server subprocess
var lsp_server : ChildProcess;
var buf_stdout : string = "";
var buf_stderr : string = "";

/// Squirrel's output pretty-printing

/** Convert Squirrel's output to text suitable for HTML display */
function squirrelAsHTML(body : string) : string {
	// Updating default font color to active theme
	if (
				(vscode.window.activeColorTheme.kind === vscode.ColorThemeKind.Light
		|| vscode.window.activeColorTheme.kind === vscode.ColorThemeKind.HighContrastLight)
		&& (foreground_webview_color === "#FFF")
	) {
		foreground_webview_color = "#000";
		convertANSIToHTML = new ConvertANSIToHTML({
			fg: foreground_webview_color,
			newline: true,
			escapeXML: true
		});
	} else if (
			(vscode.window.activeColorTheme.kind === vscode.ColorThemeKind.Dark
		|| vscode.window.activeColorTheme.kind === vscode.ColorThemeKind.HighContrast)
		&& (foreground_webview_color === "#000")
	) {
		foreground_webview_color = "#FFF";
		convertANSIToHTML = new ConvertANSIToHTML({
			fg: foreground_webview_color,
			newline: true,
			escapeXML: true
		});
	}
	return convertANSIToHTML.toHtml(body);
}

// Mapping identifiers of files to a proof state
var proofStates : Map<string, SquirrelDocumentProofState> = new Map();

/// Interaction with LSP

import { TextEncoder } from "node:util";

var idx : number = 0;
/** Sends [msg] to LSP server, computing header on [data] 
 */
function LSPSend(obj : object, withUniqueId : boolean = false) {
	if (lsp_server.stdin === null) {
		console.error("LSP server: stdin undefined while sending");
		debugChannel.appendLine("LSP server: stdin undefined while sending.");
	} else {
		if (withUniqueId) {
			var obj2 : any = obj; // TODO see if there's no better option (intermediary variable because of cast typing issue)
			obj2.id = idx;
			idx += 1;
		}
		// lsp_server.stdin.write(msg_with_header);
		const data : string = JSON.stringify(obj2);
		const encoder = new TextEncoder();
		lsp_server.stdin.setDefaultEncoding("utf-8");
		const encoded_msg_payload = encoder.encode(data);
		const msg_header = `Content-Length: ${encoded_msg_payload.length}\r\n\r\n`;
		lsp_server.stdin.write(encoder.encode(msg_header));
		lsp_server.stdin.write(encoded_msg_payload);
		if (DEBUG_MODE) {
			console.log(`==== Sent ====\n${msg_header}${data}\n============`);
			debugChannel.appendLine(`==== Sent ====\n${msg_header}${data}\n============`);
		}
	}
}

/** Manage [data] received on stdout, if [data] represent a single JSON object. */
function LSPRecvStdout(data : string) : void {
	const objRcvd = JSON.parse(data);
	if (Object.hasOwn(objRcvd, "method")) {
		if (objRcvd.method === "pysquirrellsp/squirrelProofOutput") {
			if(!(Object.hasOwn(objRcvd, "kind"))) {
				vscode.window.showErrorMessage("Received LSP message without expected field [kind].");
			} else {
				if(!(Object.hasOwn(objRcvd, "documentId"))) {
					vscode.window.showErrorMessage("Received LSP message without expected field [kind].");
				} else {
					let proofState = proofStates.get(objRcvd.documentId);
					if (proofState === undefined) {
						vscode.window.showErrorMessage("Panic: LSP server mentions a closed or nonexistent file.");
					} else {
						const moveCursor : boolean = Object.hasOwn(objRcvd, "moveCursor");
						if (objRcvd.kind === "goal") {
							if (Object.hasOwn(objRcvd, "resetResponses")) {
								proofState.proofStateMain = [];
							}
							proofState.proofStateResponses = [];
							proofState.proofStateMain.push(squirrelAsHTML(objRcvd.payload));
							if (!(Object.hasOwn(objRcvd, "continuing"))) {
								if (!Object.hasOwn(objRcvd, "startSquirrel")) {
									proofState.commandResponseReceived(/*error = */undefined, /*moveCursor = */moveCursor);
								}
								proofState.refreshHighlights();
								proofState.waitingForProofProcessing = false;
								proofState.updateProofStateInWebview();
							}
						} else {
							if (Object.hasOwn(objRcvd, "resetResponses")) {
								proofState.proofStateResponses = [];
							}
							// Display squirrel's response on proof panel
							proofState.proofStateResponses.push([objRcvd.kind, squirrelAsHTML(objRcvd.payload)]);
							if (!(Object.hasOwn(objRcvd, "continuing"))) {
								if (Object.hasOwn(objRcvd, "commandFailed")) {
									if (!Object.hasOwn(objRcvd, "startSquirrel")) {
										proofState.commandResponseReceived(/*error = */true, /*moveCursor = */moveCursor);
									}
									proofState.refreshHighlights();
									proofState.updateProofStateInWebview();
								} else {
									if (!Object.hasOwn(objRcvd, "startSquirrel")) {
										proofState.commandResponseReceived(/*error = */undefined, /*moveCursor = */moveCursor);
									}
									proofState.refreshHighlights();
									proofState.updateProofStateInWebview();
								}
							}
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
	let objRcvd;
	try {
		objRcvd = JSON.parse(data);
	} catch (e) {
		vscode.window.showWarningMessage(data);
	}

	if (Object.hasOwn(objRcvd, "method")) {
		if (objRcvd.method === "pysquirrellsp/lsperror") {
			// If LSP failed to start squirrel, we remove the corresponding `ProofState` from `proofStates`
			if (Object.hasOwn(objRcvd, "failStartup")) {
				const documentId : string = objRcvd.failStartup;
				if (proofStates.has(documentId)) {
					closeProofClientSide(documentId, true);
				}
			}
			vscode.window.showWarningMessage(`VSquirrel LSP error message: ${objRcvd.data}`);
			if (DEBUG_MODE) {
				console.error(`VSquirrel LSP error message: ${objRcvd.data}`);
			}
		} else if (objRcvd.method === "pysquirrellsp/debug") {
			console.error(`VSquirrel LSP debug message: ${objRcvd.data}`);
			debugChannel.appendLine(`VSquirrel LSP debug message: ${objRcvd.data}`);
		} else {
			vscode.window.showErrorMessage(`VSquirrel: LSP server stderr: ${data}`);
			if (DEBUG_MODE) {
				console.error(`VSquirrel: LSP server stderr: ${data}`);
			}
		}
	} else {
		vscode.window.showErrorMessage(`VSquirrel: LSP server stderr: ${data}`);
		if (DEBUG_MODE) {
			console.error(`VSquirrel: LSP server stderr: ${data}`);
		}
	}
}
/// Closing proofs

function closeProofClientSide(documentId : string, disposeWebviewPanel : boolean) : boolean {
	// `proofState.closing` is used to avoid loop in case closeProof --triggers--> dispose webview --triggers--> closeProof ...
	let proofState = proofStates.get(documentId);
	if (proofState === undefined) {
		vscode.window.showErrorMessage("VSquirrel: Proof is not started.");
		return false;
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
		return true;
	}
	return false;
}

function closeProof(documentId : string, disposeWebviewPanel : boolean) : void {
	if (closeProofClientSide(documentId, disposeWebviewPanel)) {
		// Telling the server to close proof
		LSPSend({method:"pysquirrellsp/closeProof", documentId: documentId}, true);
	}
}

export function activate(context: vscode.ExtensionContext) {
	debugChannel = vscode.window.createOutputChannel("Squirrel Debug", {log : true});

	/// Paths to required software
	if (DEBUG_MODE) {
		debugChannel.appendLine(`Configuration: ${vscode.workspace.getConfiguration("vsquirrel").get("lsp.pythonInterpreterPath")} ||| ${vscode.workspace.getConfiguration("vsquirrel").get("squirrelPath")}`);
	}
	const configPythonPath : string | undefined = vscode.workspace.getConfiguration("vsquirrel").get("lsp.pythonInterpreterPath");
	const configSquirrelPath : string | undefined = vscode.workspace.getConfiguration("vsquirrel").get("squirrelPath");

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
		squirrelPath = "~/";
	}
	// Path to LSP server
	let serverStartCLOptions : string[] = [path.join(context.extensionPath, "server", "pysquirrel-prover-lsp", "squirrel_server.py")];
	const server_workdir : string = context.asAbsolutePath(path.join('server', 'pysquirrel-prover-lsp'));

	if (DEBUG_MODE) {
		console.log(`${pythonPath} ${serverStartCLOptions}`);
		debugChannel.appendLine(`${pythonPath} ${serverStartCLOptions}`);
	}

	// Spawning LSP Server
	lsp_server = spawn(pythonPath, serverStartCLOptions, { "cwd": server_workdir });

	if (lsp_server.stdout !== null) {
		lsp_server.stdout.setEncoding("utf8");
		lsp_server.stdout.on('data', (data : string) => {
			buf_stdout += data;
			if (DEBUG_MODE) {
				console.log(`==stdout==\n${data}\n==end stdendout==`);
				debugChannel.appendLine(`==stdout==\n${data}\n==end stdendout==`);
			}
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
					} else if(line.substring(0, contentlengthFieldTitle.length).toLowerCase() === contentlengthFieldTitle.toLowerCase()) {
						const splitLine = line.split(":");
						if (splitLine.length >= 2) { // Otherwise, we wait for more output from LSP server
							contentLength = parseInt(splitLine[1]);
						}
					}
				}
				if (contentLength !== undefined) {
					// Reconstituting the payload
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
		debugChannel.appendLine(`LSP server: stdout undefined`);
	}

	if (lsp_server.stderr !== null) {
		lsp_server.stderr.setEncoding("utf8");
		lsp_server.stderr.on('data', (data : string) => {
			buf_stderr += data;
			if (DEBUG_MODE) {
				console.error(`==stderr==\n${data}\n==end stderr==`);
				debugChannel.appendLine(`==stderr==\n${data}\n==end stderr==`);
			}
			// Parsing buffer. It may contain several chunks of the form HEADER\r\nAJSONOBJECT. We read all such chunks and pass them to LSPRecvStderr
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
		debugChannel.appendLine(`LSP server: stderr undefined`);
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
					`Squirrel ${path.basename(textEditor.document.fileName)}`,
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
				// Finding paths to python and squirrel
				var squirrelPath : string;
				// Paths to required software
				const configSquirrelPath2 : string | undefined = vscode.workspace.getConfiguration('vsquirrel').get("squirrelPath");
				if (configSquirrelPath2 !== undefined) {
					squirrelPath = configSquirrelPath2;
				} else {
					squirrelPath = "~/squirrel-prover/squirrel";
				}
				if (DEBUG_MODE) {
					debugChannel.appendLine(`Path to squirrel before sending to LSP: ${squirrelPath}`);
				}
				// Adding an entry to proof states for this file and information to the LSP server
				proofStates.set(
					textEditor.document.fileName,
					new SquirrelDocumentProofState(
						textEditor,
						proofPanel,
						(msg : Object) => { LSPSend(msg, true); },
						(msg : string) => { console.log(msg); debugChannel.appendLine(msg); },
						vscode.workspace.getConfiguration("vsquirrel").get("webviewFontSize")
					)
				);
				LSPSend({method:"pysquirrellsp/startProof", pathToSquirrel: squirrelPath, documentId: textEditor.document.fileName}, true);
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
			} else {
				proofState.nextProof();
			}
		}
	);

	// Undo last proof command, if any.
	const undoProofCmd = vscode.commands.registerTextEditorCommand('vsquirrel.undoProof',
		(textEditor: vscode.TextEditor, edit: vscode.TextEditorEdit, args: any[]) => {
			const proofState : SquirrelDocumentProofState | undefined = proofStates.get(textEditor.document.fileName);
			if (proofState === undefined) {
				vscode.window.showErrorMessage("VSquirrel: You must first start the proof.");
			} else {
				proofState.undoProof();
			}
		}
	);
	
	// Process commands up to the first dot preceding current cursor's position.
	const goToProofCmd = vscode.commands.registerTextEditorCommand('vsquirrel.goToProof',
		(textEditor: vscode.TextEditor, edit: vscode.TextEditorEdit, args: any[]) => {
			const proofState : SquirrelDocumentProofState | undefined = proofStates.get(textEditor.document.fileName);
			if (proofState === undefined) {
				vscode.window.showErrorMessage("VSquirrel: You must first start the proof.");
			} else {
				proofState.interpretToPosition(textEditor.selection.active);
			}
		}
	);

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
				if (minimalModifiedPoint !== undefined) {
					if (proofState.lastErrorProofPosition !== undefined) {
						if (minimalModifiedPoint.isBefore(proofState.lastErrorProofPosition)) {
							proofState.clearError();
						}
					}
					if (minimalModifiedPoint.isBefore(proofState.endProofPosition)) {
						proofState.interpretToPosition(minimalModifiedPoint, false);
					}
					proofState.refreshHighlights();
				}
			}
		},
	);

	context.subscriptions.push(startProofCmd);
	context.subscriptions.push(closeProofCmd);
	context.subscriptions.push(nextProofCmd);
	context.subscriptions.push(undoProofCmd);
	context.subscriptions.push(goToProofCmd);
}

export function deactivate() {
	lsp_server.kill();
}
