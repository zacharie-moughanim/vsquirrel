// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from 'vscode';

import * as path from 'path';
import { ChildProcess } from 'child_process';

const { spawn } = require('node:child_process');
const net = require('node:net');
const assert = require('node:assert');

// Console channel for debug messages
let debugChannel : vscode.OutputChannel;
var client : any;

// Paths to required software
const configPythonPath : string | undefined = vscode.workspace.getConfiguration('SquirrelProver').get("lsp.pythonInterpreterPath");
const configSquirrelPath : string | undefined = vscode.workspace.getConfiguration('SquirrelProver').get("squirrelPath");

// The LSP server subprocess
var lsp_server : ChildProcess;

// Position of the beginning of the document and of the last point where the proof was processed.
const startDocumentPosition = new vscode.Position(0, 0);
var endProofPosition : vscode.Position | undefined = undefined;

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
		console.log("LSP server: stdin undefined while sending");
	} else {
		if (withUniqueId) {
			var obj2 : any = obj; // TODO see if there's no better option
			obj2.id = idx;
			idx += 1;
		}
		const data : string = JSON.stringify(obj2);
		const msg_with_header : string = `Content-Length: ${data.length}\r\n\r\n${data}`;
		lsp_server.stdin.write(`${msg_with_header}\r\n`);
		console.log(`==== Sent ====\n${msg_with_header}\n============`);
	}
}

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

/// Find position of next dot in the [doc] from the position [from].
function findNextDot(doc : vscode.TextDocument, from : vscode.Position) : vscode.Position | undefined {
	var curChar : string;
	var curPos : vscode.Position = from;
	var nextPos : vscode.Position | undefined;
	do {
		nextPos = nextCharacterPosition(doc, curPos);
		if (nextPos === undefined) {
			return undefined;
		}
		curChar = doc.getText(new vscode.Range(curPos, nextPos));
		curPos = nextPos;
	} while (curChar !== '.');
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
		lsp_server.stdout.on('data', (data : string) => {
			// TODO parse, add header to server messages to etc...
			console.log(`==stdout==\n${data}\n==end stdout==`);
			debugChannel.appendLine(data.toString());
		});
	} else {
		console.error("LSP server: stdout undefined");
	}
	
	if (lsp_server.stderr !== null) {
		lsp_server.stderr.on('data', (data : string) => {
			console.error(`==stderr==\n${data}\n==end stderr==`);
		});
	} else {
		console.error("LSP server: stderr undefined");
	}

	lsp_server.on('close', (code : number, signal : string) => {
		if (signal !== null) {
			console.log(`LSP server exited with code ${code} and signal ${signal}`);
		} else {
			console.log(`LSP server exited with code ${code}`);
		}
	});

	lsp_server.on('error', (err : Error) => {
		console.error(`LSP server error: ${err}`);
	});

	// Decorations
	var processedProofColor = "#00f04857";
	var testDeco = vscode.window.createTextEditorDecorationType({backgroundColor : processedProofColor});

	const killServer = vscode.commands.registerCommand('vsquirrel.killServer', () => {
		lsp_server.kill();
	});

	const startProofCmd = vscode.commands.registerTextEditorCommand('vsquirrel.startProof',
		(textEditor: vscode.TextEditor, edit: vscode.TextEditorEdit, args: any[]) => {
			endProofPosition = new vscode.Position(0, 0);
			LSPSend({method:"vsquirrel/startProof", pathToSquirrel: squirrelPath}, true);
		}
	);
	
	const nextProofCmd = vscode.commands.registerTextEditorCommand('vsquirrel.nextProof',
		(textEditor: vscode.TextEditor, edit: vscode.TextEditorEdit, args: any[]) => {
			if (endProofPosition === undefined) {
				vscode.window.showErrorMessage("You must first start the proof.");
			} else {
				const nextDotPosition : vscode.Position | undefined = findNextDot(textEditor.document, endProofPosition);
				if (nextDotPosition === undefined) {
					vscode.window.showErrorMessage("No dot to get the proof to in the remaining of the document.");
				} else {
					const bufferProof = textEditor.document.getText(new vscode.Range(endProofPosition, nextDotPosition));
					LSPSend({method:"vsquirrel/nextProof", proofCommand: bufferProof}, true);
					textEditor.selection = new vscode.Selection(nextDotPosition, nextDotPosition);
					textEditor.setDecorations(testDeco, [new vscode.Range(startDocumentPosition, nextDotPosition)]);
					endProofPosition = new vscode.Position(nextDotPosition.line, nextDotPosition.character);
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
