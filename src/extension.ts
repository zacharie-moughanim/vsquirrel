import * as vscode from 'vscode';

import * as path from 'path';
import { debug } from 'console';

import { SquirrelDocumentProofState } from './proofState';
import { LSPHandle } from './lspHandle';

// Whether to display debug messages
const DEBUG_MODE : boolean = false;

// Console channel for debug messages
var debugChannel : vscode.OutputChannel;

var lspServerHandle : LSPHandle;

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
	const serverWorkdir : string = context.asAbsolutePath(path.join('server', 'pysquirrel-prover-lsp'));

	if (DEBUG_MODE) {
		console.log(`${pythonPath} ${serverStartCLOptions}`);
		debugChannel.appendLine(`${pythonPath} ${serverStartCLOptions}`);
	}

	// Spawning LSP Server
	// lsp_server = spawn(pythonPath, serverStartCLOptions, { "cwd": serverWorkdir });
	var lspServerHandle = new LSPHandle(
		pythonPath,
		serverWorkdir,
		serverStartCLOptions,
		(msg : string) => { console.log(msg); debugChannel.appendLine(msg); },
		DEBUG_MODE
	);


	// Command to start a proof on a given file
	const startProofCmd = vscode.commands.registerTextEditorCommand('vsquirrel.startProof',
		(textEditor: vscode.TextEditor, edit: vscode.TextEditorEdit, args: any[]) => {
			const prevProofState : SquirrelDocumentProofState | undefined = lspServerHandle.proofStates.get(textEditor.document.fileName);
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
						lspServerHandle.closeProof(textEditor.document.fileName, false);
					},
					null,
					context.subscriptions
				);
				vscode.window.onDidChangeActiveTextEditor((activeEditor : vscode.TextEditor | undefined) => {
					if (activeEditor !== undefined) {
						let proofState = lspServerHandle.proofStates.get(activeEditor.document.fileName);
						if (proofState !== undefined) {
							proofState.proofPanel.reveal();
						}
					}
 				});
				// Update editors registered in [proofState] on tab change, and refresh highlights when a document is made visible again.
				vscode.window.onDidChangeVisibleTextEditors((editors : readonly vscode.TextEditor[]) => {
					for (let editor of editors) {
						let proofState = lspServerHandle.proofStates.get(editor.document.fileName);
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
				lspServerHandle.proofStates.set(
					textEditor.document.fileName,
					new SquirrelDocumentProofState(
						textEditor,
						proofPanel,
						(msg : Object) => { lspServerHandle.LSPSend(msg, true); },
						(msg : string) => { console.log(msg); debugChannel.appendLine(msg); },
						vscode.workspace.getConfiguration("vsquirrel").get("webviewFontSize")
					)
				);
				lspServerHandle.LSPSend({method:"pysquirrellsp/startProof", pathToSquirrel: squirrelPath, documentId: textEditor.document.fileName}, true);
			}
		}
	);

	// Command to close a proof on a given file
	const closeProofCmd = vscode.commands.registerTextEditorCommand('vsquirrel.closeProof',
		(textEditor: vscode.TextEditor, edit: vscode.TextEditorEdit, args: any[]) => {
			lspServerHandle.closeProof(textEditor.document.fileName, true);
		}
	);
	
	// Process proof until next [.]
	const nextProofCmd = vscode.commands.registerTextEditorCommand('vsquirrel.nextProof',
		(textEditor: vscode.TextEditor, edit: vscode.TextEditorEdit, args: any[]) => {
			const proofState : SquirrelDocumentProofState | undefined = lspServerHandle.proofStates.get(textEditor.document.fileName);
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
			const proofState : SquirrelDocumentProofState | undefined = lspServerHandle.proofStates.get(textEditor.document.fileName);
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
			const proofState : SquirrelDocumentProofState | undefined = lspServerHandle.proofStates.get(textEditor.document.fileName);
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
			const proofState : SquirrelDocumentProofState | undefined = lspServerHandle.proofStates.get(event.document.fileName);
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
	lspServerHandle.kill();
}
