// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from 'vscode';
import * as path from 'path';

const { spawn } = require('node:child_process');
const net = require('node:net');

// Console channel for debug messages
let debugChannel : vscode.OutputChannel;
var client : any;

// This method is called when your extension is activated
// Your extension is activated the very first time the command is executed
export function activate(context: vscode.ExtensionContext) {

	// Use the console to output diagnostic information (console.log) and errors (console.error)
	// This line of code will only be executed once when your extension is activated
	console.log('Congratulations, your extension "vsquirrel" is now active!');
	
	debugChannel = vscode.window.createOutputChannel("Squirrel Debug", {log : true});

	// Directory of the extension
	const pythonInterpreter : string = "python3"; // TODO
	let serverStartCLOptions : string[] = ["squirrel_server.py"];
	const server_workdir : string = context.asAbsolutePath(path.join('server'));

	console.log(`${pythonInterpreter} ${serverStartCLOptions}`);

	// Spawning LSP Server
	const lsp_server = spawn(pythonInterpreter, serverStartCLOptions, { "cwd": server_workdir });
	lsp_server.stdout.on('data', (data : string) => {
		console.log(`stdout: ${data}`);
	});

	lsp_server.stderr.on('data', (data : string) => {
		console.error(`stderr: ${data}`);
	});

	lsp_server.on('close', (code : number) => {
		console.log(`LSP server exited with code ${code}`);
	});

	// The command has been defined in the package.json file
	// Now provide the implementation of the command with registerCommand
	// The commandId parameter must match the command field in package.json
	const disposable = vscode.commands.registerCommand('vsquirrel.helloWorld', () => {
		// The code you place here will be executed every time your command is executed
		// Display a message box to the user
		vscode.window.showInformationMessage('Hello World from vsquirrel!');
	});

	const sendStuff = vscode.commands.registerCommand('vsquirrel.sendStuff', () => {
		// TODO
	});

	context.subscriptions.push(disposable);
	context.subscriptions.push(sendStuff);
}

// This method is called when your extension is deactivated
export function deactivate() {
}
