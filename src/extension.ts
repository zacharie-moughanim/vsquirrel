// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from 'vscode';

import * as path from 'path';
import { ChildProcess } from 'child_process';
import { debug } from 'console';

const { spawn } = require('node:child_process');

var ConvertANSIToHTML = require('ansi-to-html');

var convertANSIToHTML = new ConvertANSIToHTML();

// Whether to display debug messages
const DEBUG_MODE : boolean = true;

// Console channel for debug messages
let debugChannel : vscode.OutputChannel;
var client : any;

// The LSP server subprocess
var lsp_server : ChildProcess;
var buf_stdout : string = "";
var buf_stderr : string = "";

// Debug pretty-printing

function string_of_position(pos : vscode.Position | undefined) : string {
	if (pos === undefined) {
		return "undefined";
	} else {
		return `(l. ${pos.line}, c. ${pos.character})`;
	}
}

function string_of_positions(poses : (vscode.Position | undefined)[]) : string {
	let buf : string = "[ ";
	for (let i = 0; i < poses.length; ++i) {
		let pos = poses.at(i);
		if (i !== 0) {
			buf += "; ";
		}
		if (pos === undefined) {
			buf += "undefined ";
		} else {
			buf += `(l. ${pos.line}, c. ${pos.character}) `;
		}
	}
	return (buf + "]");
}

/// HELPER EDITOR FUNCTIONS: to navigate in the document

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

/** Returns last valid position before [from] in [doc]. It may substract a line if the position is at the very beginning of a line.
 *  Returns [undefined] if [from] is the first valid position in [doc].  */
function prevCharacterPosition(doc : vscode.TextDocument, from : vscode.Position) : vscode.Position | undefined {
	if (from.character > 0) {
		return new vscode.Position(from.line, from.character - 1);
	} else {
		if (from.line > 0) {
			const prevPos =  doc.lineAt(from.line - 1).range.end;
			const validPrevPos = doc.validatePosition(prevPos);
			if (validPrevPos.character === prevPos.character && validPrevPos.line === prevPos.line) {
				return prevPos;
			} else {
				return undefined;
			}
		} else {
			return undefined;
		}
	}
}

/** Find position of next dot in the [doc] from the position [from], ignoring comments e.g. on [(* a sentence. *) Proof.], it returns the position of the second dot. */
function findNextDot(doc : vscode.TextDocument, from : vscode.Position) : vscode.Position | undefined {
	var prevChar : string;
	var curChar : string = "";
	var curPos : vscode.Position = from;
	var nextPos : vscode.Position | undefined;
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

function findPrevDot(doc : vscode.TextDocument, from : vscode.Position) : vscode.Position | undefined {
	var nextChar : string;
	var curChar : string = "";
	var curPos : vscode.Position = from;
	var predPos : vscode.Position | undefined;
	var withinComment : boolean = false;
	do {
		predPos = prevCharacterPosition(doc, curPos);
		if (predPos === undefined) {
			return undefined;
		}
		nextChar = curChar;
		curChar = doc.getText(new vscode.Range(predPos, curPos));
		curPos = predPos;
		if (withinComment) {
			if (curChar === "(" && nextChar === "*") {
				withinComment = false;
			}
		} else {
			if (curChar === "*" && nextChar === ")") {
				withinComment = true;
			}
		}
	} while (!(curChar === '.' && !withinComment));
	return predPos;
}

function countDotBetween(doc : vscode.TextDocument, from : vscode.Position, to : vscode.Position) : number {
	let prevChar : string;
	let curChar : string = "";
	let curPos : vscode.Position = from;
	let nextPos : vscode.Position | undefined;
	let withinComment : boolean = false;
	var cnt : number = 0; 
	while (curPos.isBeforeOrEqual(to)) {
		nextPos = nextCharacterPosition(doc, curPos);
		if (nextPos === undefined) {
			return cnt;
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
			if (curChar === ".") {
				++cnt;
			}
		}
	}
	return cnt;
}

/// Squirrel's output pretty-printing

/** Convert Squirrel's output to text suitable for HTML */
function squirrelAsHTML(body : string) : string {
	return convertANSIToHTML.toHtml(body).replaceAll("\n", "<br/>");
}

/// PROOFS STATE

// Position of the beginning of the document, of the last point requested to be processed, and of the last point where the proof was processed.
const startDocumentPosition = new vscode.Position(0, 0);

// Decorations
var processingProofColor = new vscode.ThemeColor("vsquirrel.proof.processing");
var processedProofColor = new vscode.ThemeColor("vsquirrel.proof.processed");
var processedErrorProofColor = new vscode.ThemeColor("vsquirrel.proof.error");

class commandWaitingForProcessingData {
	command : string;
	endPos : vscode.Position;

	constructor(cmd : string, pos : vscode.Position) {
		this.command = cmd;
		this.endPos = pos;
	}
}

class commandBuffer {
	private content : commandWaitingForProcessingData[];

	constructor() {
		this.content = [];
	}

	public enqueue(proofCommand : commandWaitingForProcessingData) : void {
		this.content.push(proofCommand);
	}

	public dequeue() : commandWaitingForProcessingData | undefined {
		return this.content.shift();
	}

	public clear() : void {
		this.content = [];
	}

	public isEmpty() : boolean {
		return this.content.length === 0;
	}
}

class SquirrelDocumentProofState {
	// Panels: editor & proof panel
	editor : vscode.TextEditor;
	proofPanel : vscode.WebviewPanel;
	// Global state maintaining what's to be displayed on the proof panel.
	proofStateMain : string[];
	proofStateResponses : [string, string][]; // Must be reset to [undefined] at each new command.
	// Positions
	/** Is the maximum position between `lastProcessedProofPosition`, `lastProcessingProofPosition` and `lastErrorProofPosition`.  */
	endProofPosition : vscode.Position; 
	lastProcessedProofPosition : vscode.Position;
	lastProcessedProofPositionHistoric : vscode.Position[];
	lastProcessingProofPosition : vscode.Position | undefined;
	lastErrorProofPosition : vscode.Position | undefined;
	/**
	 * Whether a command was sent to the LSP server and we're waiting for a response.
	 * INVARIANT: waitingForProofProcessing === (commandSentToLSP !== undefined)
	 * TODO remove in favor of the invariant.
	 */
	waitingForProofProcessing : boolean;
	/** List of command that are waiting to be processed (e.g. after an interpretToPosition) */
	commandsWaitingQueue : commandBuffer;
	/** The command sent to LSP server for which no response has been received yet, if any.
	 * If it's a number, then it corresponds to an `undo` and the value is the argument of `undo`
	 * Otherwise, the value is a range such that the command sent is this.document.getText(commandSentToLSP).
	 */
	commandSentToLSP : vscode.Position | number | undefined;
	// Decorations
	decorationProcessingProof : vscode.TextEditorDecorationType;
	decorationProcessedProof : vscode.TextEditorDecorationType;
	decorationErrorProof : vscode.TextEditorDecorationType;

	closing : boolean;

	constructor(
		editor : vscode.TextEditor,
		proofPanel : vscode.WebviewPanel,
		endPos : vscode.Position = new vscode.Position(0, 0),
		lastProcessedPos = new vscode.Position(0, 0),
		waitingForProofProcessing = false,
		decorationProcessingProof = vscode.window.createTextEditorDecorationType({backgroundColor : processingProofColor, rangeBehavior : vscode.DecorationRangeBehavior.ClosedClosed}),
		decorationProcessedProof = vscode.window.createTextEditorDecorationType({backgroundColor : processedProofColor, rangeBehavior : vscode.DecorationRangeBehavior.ClosedClosed}),
		decorationErrorProof = vscode.window.createTextEditorDecorationType({backgroundColor : processedErrorProofColor, rangeBehavior : vscode.DecorationRangeBehavior.ClosedClosed})
	) {
		this.editor = editor;
		this.proofPanel = proofPanel;

		this.proofStateMain = [];
		this.proofStateResponses = [];

		this.endProofPosition = endPos;
		this.lastProcessedProofPosition = lastProcessedPos;
		this.waitingForProofProcessing = waitingForProofProcessing;
		this.lastProcessedProofPositionHistoric = [this.lastProcessedProofPosition];
		this.commandsWaitingQueue = new commandBuffer();

		this.decorationProcessingProof = decorationProcessingProof;
		this.decorationProcessedProof = decorationProcessedProof;
		this.decorationErrorProof = decorationErrorProof;

		this.closing = false;
	}

	// positions setters and modifiers.

	public refreshEndProofPosition() {
		if (this.lastErrorProofPosition === undefined) {
			if (this.lastProcessingProofPosition === undefined) {
				this.endProofPosition = this.lastProcessedProofPosition;
			} else {
				if (this.lastProcessingProofPosition.isBefore(this.lastProcessedProofPosition)) {
					console.log("PANIC invariant on positions");
					debugChannel.appendLine("PANIC invariant on positions");
					this.endProofPosition = this.lastProcessedProofPosition;
				} else {
					this.endProofPosition = this.lastProcessingProofPosition;
				}
			}
		} else {
			if (this.lastProcessingProofPosition !== undefined) {
				console.log("PANIC invariant on positions TODO error/processing");
				debugChannel.appendLine("PANIC invariant on positions  TODO error/processing");
			} else {
				if (this.lastErrorProofPosition.isBefore(this.lastProcessedProofPosition)) {
					console.log("PANIC invariant on positions");
					debugChannel.appendLine("PANIC invariant on positions");
					this.endProofPosition = this.lastProcessedProofPosition;
				} else {
					this.endProofPosition = this.lastErrorProofPosition;
				}
			}
		}
	}

	public updateLastProcessingProofPosition(pos : vscode.Position | undefined) {
		this.lastProcessingProofPosition = pos;
		if (this.lastProcessingProofPosition === undefined) {
			this.refreshEndProofPosition();
		} else {
			if (this.lastProcessingProofPosition.isAfter(this.endProofPosition)) {
				this.endProofPosition = this.lastProcessingProofPosition;
			}
		}
	}

	public updateLastProcessedProofPosition(pos : vscode.Position) {
		this.lastProcessedProofPositionHistoric.push(pos);
		this.lastProcessedProofPosition = pos;
		if (this.lastProcessedProofPosition.isAfter(this.endProofPosition)) {
			this.endProofPosition = this.lastProcessedProofPosition;
		}
	}

	public updateLastErrorProofPosition(pos : vscode.Position | undefined) {
		this.lastErrorProofPosition = pos;
		if (this.lastErrorProofPosition === undefined) {
			this.refreshEndProofPosition();
		} else {
			if (this.lastErrorProofPosition.isAfter(this.endProofPosition)) {
				this.endProofPosition = this.lastErrorProofPosition;
			}
		}
	}

	/** Sets `lastProcessedProofPosition` to its previous value. */
	public undoLastProcessedProofPosition() : void {
		if (this.lastProcessedProofPositionHistoric.length < 2) { // The historic must contain two positions: (..., position to restore, position to remove)
			vscode.window.showErrorMessage("Nothing to undo (position).");
			debugChannel.appendLine(`${string_of_positions(this.lastProcessedProofPositionHistoric)}`);
		} else {
			this.lastProcessedProofPositionHistoric.pop();
			const posToRestore = this.lastProcessedProofPositionHistoric.at(-1);
			if (posToRestore === undefined) {
				vscode.window.showErrorMessage("panic. not supposed to happen because we're in the else branch of the condition above.");
			} else {
				this.lastProcessedProofPosition = posToRestore; // Correct even if .at returns [undefined]
			}
			this.refreshEndProofPosition();
		}
	}

	/**
	 * Re-establish positions to the state it was before the last processed command.
	 */
	public undoPositions() {
		if (this.lastProcessingProofPosition !== undefined) {
			console.log("PANIC. Trying to undo positions while a command is in processing.");
			debugChannel.appendLine("PANIC. Trying to undo positions while a command is in processing.");
		} else {
			if (this.endProofPosition === this.lastProcessedProofPosition) {
				this.undoLastProcessedProofPosition();
				this.endProofPosition = this.lastProcessedProofPosition;
			} else if (this.endProofPosition === this.lastErrorProofPosition) {
				this.lastErrorProofPosition = undefined;
				this.endProofPosition = this.lastProcessedProofPosition;
			} else {
				console.log("PANIC. Invariant on positions is false.");
				debugChannel.appendLine("PANIC. Invariant on positions is false.");
			}
		}
	}

	public clearError() {
		this.updateLastErrorProofPosition(undefined);
	}

	/// CURSOR 

	public moveCursorToEnd() {
		this.editor.selection = new vscode.Selection(this.endProofPosition, this.endProofPosition);
		this.editor.revealRange(new vscode.Range(this.endProofPosition, this.endProofPosition));
	}

	/** Updates the highlighting in document w.r.t. positions:
	 * from the start of the document to `lastProcessedProofPosition` is highlighted with the corresponding color;
	 * from `lastProcessedProofPosition` to `lastProcessingProofPosition` is highlighted with the corresponding color, or this highlighting is cleared if `lastProcessingProofPosition` is `undefined`;
	 * from `lastProcessedProofPosition` to `lastErrorProofPosition` is highlighted with the corresponding color, or this highlighting is cleared if `lastErrorProofPosition` is `undefined`.
	 */
	public refreshHighlights() {
		this.editor.setDecorations(this.decorationProcessedProof, [new vscode.Range(startDocumentPosition, this.lastProcessedProofPosition)]);
		if (this.lastProcessingProofPosition !== undefined) {
			this.editor.setDecorations(this.decorationProcessingProof, [new vscode.Range(this.lastProcessedProofPosition, this.lastProcessingProofPosition)]);
		} else {
			this.editor.setDecorations(this.decorationProcessingProof, []);
		}
		if (this.lastErrorProofPosition !== undefined) {
			this.editor.setDecorations(this.decorationErrorProof, [new vscode.Range(this.lastProcessedProofPosition, this.lastErrorProofPosition)]);
		} else {
			this.editor.setDecorations(this.decorationErrorProof, []);
		}
	}

	/// Returns proof states in an HTML page, adapted to display in a webview.
	public updateProofStateInWebview() : void {
		let HTMLProofStateResponses : string = "";
		let HTMLProofMain : string = "";
		let CSSColorStart : string;
		let CSSColorWarning : string;
		let CSSColorError : string;
		if (vscode.window.activeColorTheme.kind === vscode.ColorThemeKind.Dark || vscode.window.activeColorTheme.kind === vscode.ColorThemeKind.HighContrast) {
			CSSColorStart = "#a8fcff"; // TODO see if we can instead use vscode.THemeColor
			CSSColorWarning = "#ffe605";
			CSSColorError = "#f00000";
		} else {
			CSSColorStart = "#135dff";
			CSSColorWarning = "#ff9100";
			CSSColorError = "#f00000";
		}
		let responsesStyle : string = `#responses {
		height: 50%;
			overflow: scroll;
		}
		.start {
			color: ${CSSColorStart};
		}
		.warning {
			color: ${CSSColorWarning};
		}
		.error {
			${CSSColorError}
		}
		
		`;	
		const mainStyle = `#main {
			border-bottom: .5em solid;
			height: 50%;
			overflow: scroll;
		}`;
		if (this.proofStateResponses.length > 0) {
			for (let response of this.proofStateResponses) {
				const kind : string = response[0];
				const payload : string = response[1];
				HTMLProofStateResponses += `<p class="${kind}"> ${payload} </p>`;
			}
		}
		if (this.proofStateMain.length > 0) {
			for (let goalContent of this.proofStateMain) {
				HTMLProofMain += `<p> ${goalContent} </p>`;
			}
			responsesStyle = `#responses {
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
				${responsesStyle}
				#column {
					height: 100vh;
				}
				</style>
				<title>Squirrel Proof</title>
		</head>
		<body>
			<div id="column">
				<div id="main">
					${HTMLProofMain}
				</div>
				<div id="responses">
					${HTMLProofStateResponses}
				</div>
			</div>
		</body>
		</html>`;
	}

	/// PROOF COMMANDS

	private processNextWaitingCommand() {
		if (this.commandsWaitingQueue.isEmpty()) {
			this.commandSentToLSP = undefined;
		} else {
			const mayNextCommand : commandWaitingForProcessingData | undefined = this.commandsWaitingQueue.dequeue();
			if (mayNextCommand === undefined) {
				console.log("PANIC.");
				debugChannel.appendLine("PANIC.");
			} else {
				const nextCommand : string = mayNextCommand.command;
				LSPSend({method:"vsquirrel/proofCommand", proofCommand: nextCommand, documentId: this.editor.document.fileName}, true);
				this.waitingForProofProcessing = true;
				this.commandSentToLSP = mayNextCommand.endPos;
			}
		}
	}

	public commandResponseReceived(error : boolean = false, moveCursor : boolean = false) {
		if (DEBUG_MODE) {
			debugChannel.appendLine(`BEFORE: lastProcessed: ${string_of_position(this.lastProcessedProofPosition)} ||| historic: ${string_of_positions(this.lastProcessedProofPositionHistoric)}\nlastProcessing: ${string_of_position(this.lastProcessingProofPosition)}\nlastError: ${string_of_position(this.lastErrorProofPosition)}\nend: ${string_of_position(this.endProofPosition)}`);
		}
		const mayCorrespondingCommand : vscode.Position | number | undefined = this.commandSentToLSP;
		if (mayCorrespondingCommand === undefined) {
			console.log("Panic. Received response to a command while no command was sent.");
			debugChannel.appendLine("Panic. Received response to a command while no command was sent.");
		} else {
			const correspondingCommand : vscode.Position | number = mayCorrespondingCommand;
			if (correspondingCommand instanceof vscode.Position) {
				let newLastPos : vscode.Position = correspondingCommand; 
				// If no command is in processing anymore, we unhighlight everything with the corresponding decoration.
				if (this.commandsWaitingQueue.isEmpty()) {
					this.updateLastProcessingProofPosition(undefined);
				}
				if (error) {
					this.updateLastErrorProofPosition(newLastPos);
					this.updateLastProcessingProofPosition(undefined);
					this.commandsWaitingQueue.clear();
					// Move cursor to the end of processing proof, and scroll if needed
					this.moveCursorToEnd();
				} else {
					this.updateLastProcessedProofPosition(newLastPos); 
				}
			} else {
				// Data must be a number, corresponding to an `undo` command.
				// We (visually) undo nUndos commands: update positions and move cursor to new end position.
				let nUndos : number = correspondingCommand;
				debugChannel.appendLine(`We have to undo ${nUndos}...`);
				for (let i = 0; i < nUndos; ++i) {
					this.undoPositions();
				}
				this.moveCursorToEnd();
			}
			this.waitingForProofProcessing = false;
			// If there are still command waiting to be processed, we process the next one.
			this.processNextWaitingCommand();
		}
		if (DEBUG_MODE) {
			debugChannel.appendLine(`AFTER: lastProcessed: ${string_of_position(this.lastProcessedProofPosition)} ||| historic: ${string_of_positions(this.lastProcessedProofPositionHistoric)}\nlastProcessing: ${string_of_position(this.lastProcessingProofPosition)}\nlastError: ${string_of_position(this.lastErrorProofPosition)}\nend: ${string_of_position(this.endProofPosition)}`);
		}
	}

	/** `processCommands(commands)` sends to LSP server each command in `commands`, it updates the positions and the highlighting. */
	private processCommands(commands : [string, vscode.Position][]) {
		if (this.waitingForProofProcessing) {
			// TODO authorizing the processing of several command may lead to errors, for now let's keep that and see if we can lift the restriction in the future. 
			vscode.window.showErrorMessage("VSquirrel: Wait for last command to be processed.");
		} else {
			const lastCmd : [string, vscode.Position] | undefined = commands.at(-1);
			if (lastCmd !== undefined) {
				const mayLastPos : vscode.Position | string | undefined = lastCmd.at(1);
				let lastPos : vscode.Position;
				if (mayLastPos instanceof vscode.Position) {
					lastPos = mayLastPos;
				} else {
					lastPos = new vscode.Position(0, 0);
					console.error("Panic.");
					debugChannel.appendLine("Panic.");
				}
				this.waitingForProofProcessing = true;
				for (let [cmd, pos] of commands) {
					this.commandsWaitingQueue.enqueue(new commandWaitingForProcessingData(cmd, pos));
					this.updateLastProcessingProofPosition(pos);
				}
				// Update highlighting of proof in processing
				this.refreshHighlights();
				// Move cursor to the end of processing proof, and scroll if needed
				this.moveCursorToEnd();
				this.processNextWaitingCommand();
			}
		}
	}

	/** nextProof() sends to the LSP server the command between [this.lastProcessedProofPosition] and the position of the next dot (out of comment).
	 */
	public nextProof() {
		if (this.waitingForProofProcessing) {
			// TODO authorizing the processing of several command may lead to errors, for now let's keep that and see if we can lift the restriction in the future. 
			vscode.window.showErrorMessage("VSquirrel: Wait for last command to be processed.");
		} else {
			const nextDotPosition : vscode.Position | undefined = findNextDot(this.editor.document, this.lastProcessedProofPosition);
			if (nextDotPosition === undefined) {
				vscode.window.showErrorMessage("VSquirrel: No dot to get the proof to in the remaining of the document.");
			} else {
				const bufferProof : string = this.editor.document.getText(new vscode.Range(this.lastProcessedProofPosition, nextDotPosition));
				this.processCommands([[bufferProof, nextDotPosition]]);
			}
		}
	}

	/**
	 * undoCommands(n, moveCursor) undo some commands.
	 * @param [n=1] the number of commands to undo.
	 * @param [moveCursor=true] whether to move the cursor to the new last processed point. Typically when modifying in the processed section, we don't want to move the cursor.
	 */
	private undoCommands(n : number = 1, moveCursor : boolean = true) {
		if (this.waitingForProofProcessing) { // Is actually a double-check, each call already ensures beforehand that this.waitingForProcessing is false 
			console.log("PANIC. `undoCommands` has been called while `waitingForProofProcessing` is `true`");
			debugChannel.appendLine("PANIC. `undoCommands` has been called while `waitingForProofProcessing` is `true`");
		} else {
			this.waitingForProofProcessing = true;
			this.commandSentToLSP = n;
			LSPSend({method:"vsquirrel/proofCommand", proofCommand: `undo ${n}.`, documentId: this.editor.document.fileName, moveCursor: moveCursor}, true);
			this.commandsWaitingQueue.clear();
		}
	}

	/**
	 * undo last command.
	 */
	public undoProof() {
		if (this.waitingForProofProcessing) {
			// TODO authorizing the processing of several command may lead to errors, for now let's keep that and see if we can lift the restriction in the future. 
			vscode.window.showErrorMessage("VSquirrel: Wait for last command to be processed.");
		} else {
			// If the last command resulted in an error, it is not to undo since it did not produce any result.
			if (this.lastErrorProofPosition === undefined) {
				if (findPrevDot(this.editor.document, this.lastProcessedProofPosition) === undefined) {
					vscode.window.showErrorMessage("VSquirrel: No proof command to undo.");
				} else {
					this.undoCommands(1, true); /** TODOTODOTODOTODOTODO
						+ coloring after error is green and red superposed...
					*/
				}
			} else {
				this.updateLastErrorProofPosition(undefined);
				this.moveCursorToEnd();
				// remove error response in webview
				this.proofStateResponses = [];
				this.updateProofStateInWebview();
				// remove error highlighting
				this.refreshHighlights();
			}
		}
	}

	/**
	 * Assuming no command is waiting to be processed, [interpretToPosition(pos)] interpret the file until the last point preceding [pos].
	 * @param pos The position in the file up until which we interpret.
	 */
	public interpretToPosition(pos : vscode.Position, moveCursor : boolean = true) {
		if (this.waitingForProofProcessing) {
			// TODO authorizing the processing of several command may lead to errors, for now let's keep that and see if we can lift the restriction in the future. 
			vscode.window.showErrorMessage("VSquirrel: Wait for last command to be processed.");
		} else {
			// If the position is before the last processed point, we undo some commands, otherwise we process some more commands.
			if (pos.isBefore(this.lastProcessedProofPosition)) {
				const n : number = countDotBetween(this.editor.document, pos, this.lastProcessedProofPosition);
				this.undoCommands(n, moveCursor);
			} else {
				let preTargetDotPos : vscode.Position | undefined = findPrevDot(this.editor.document, pos);
				let targetDotPos : vscode.Position;
				if (preTargetDotPos === undefined) {
					targetDotPos = new vscode.Position(0, 0);
				} else {
					targetDotPos = preTargetDotPos;
				}
				if (!targetDotPos.isEqual(this.lastProcessedProofPosition)) {
					// Iterating over the range lastProcessedProofPosition..targetDotPos, and recording all commands seen in array `commands`
					let commands : [string, vscode.Position][] = [];
					let prevChar : string;
					let curChar : string = "";
					let lastCommandBeginningPos : vscode.Position = this.lastProcessedProofPosition;
					let curPos : vscode.Position = this.lastProcessedProofPosition;
					let nextPos : vscode.Position | undefined;
					let withinComment : boolean = false;
					do {
						nextPos = nextCharacterPosition(this.editor.document, curPos);
						if (nextPos === undefined) {
							return undefined;
						}
						prevChar = curChar;
						curChar = this.editor.document.getText(new vscode.Range(curPos, nextPos));
						curPos = nextPos;
						if (withinComment) {
							if (prevChar === "*" && curChar === ")") {
								withinComment = false;
							}
						} else {
							if (prevChar === "(" && curChar === "*") {
								withinComment = true;
							}
							if (curChar === ".") {
								commands.push([this.editor.document.getText(new vscode.Range(lastCommandBeginningPos, nextPos)), nextPos]);
								lastCommandBeginningPos = nextPos;
							}
						}
					} while (nextPos.isBeforeOrEqual(targetDotPos));
					this.processCommands(commands);
				}
			}
		}	
	}
}

var proofStates : Map<string, SquirrelDocumentProofState> = new Map();

/// Proof actual evaluation (interacting with LSP)

var idx : number = 0;
/** Sends [msg] to LSP server, computing header on [data] 
 */
function LSPSend(obj : object, withUniqueId : boolean = false) {
	if (lsp_server.stdin === null) {
		console.error("LSP server: stdin undefined while sending");
		debugChannel.appendLine("LSP server: stdin undefined while sending.");
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
			debugChannel.appendLine(`==== Sent ====\n${msg_with_header}\n============`);
		}
	}
}

/** Manage [data] received on stdout, if [data] represent a single JSON object. */
function LSPRecvStdout(data : string) : void {
	const objRcvd = JSON.parse(data);
	if (Object.hasOwn(objRcvd, "method")) {
		if (objRcvd.method === "vsquirrel/squirrelProofOutput") {
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
		if (objRcvd.method === "vsquirrel/lsperror") {
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
		} else if (objRcvd.method === "vsquirrel/debug") {
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

function closeProofClientSide(documentId : string, disposeWebviewPanel : boolean) : boolean {
	// Closing is used to avoir loop in case closeProof --triggers--> dispose webview --triggers--> closeProof ...
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
		LSPSend({method:"vsquirrel/closeProof", documentId: documentId}, true);
	}
}

export function activate(context: vscode.ExtensionContext) {
	console.log('VSquirrel is now active.');
	vscode.window.showInformationMessage('VSquirrel is now active.');
	debugChannel = vscode.window.createOutputChannel("Squirrel Debug", {log : true});

	// Paths to required software
	const configPythonPath : string | undefined = vscode.workspace.getConfiguration('SquirrelProver').get("lsp.pythonInterpreterPath");
	const configSquirrelPath : string | undefined = vscode.workspace.getConfiguration('SquirrelProver').get("squirrelPath");

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

	console.log(`${pythonPath} ${serverStartCLOptions}`);
	debugChannel.appendLine(`${pythonPath} ${serverStartCLOptions}`);

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
			console.error(`==stderr==\n${data}\n==end stderr==`);
			if (DEBUG_MODE) {
				debugChannel.appendLine(`==stderr==\n${data}\n==end stderr==`);
			}
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
				// Finding paths to python and squirrel
				var squirrelPath : string;
				// Paths to required software
				const configSquirrelPath2 : string | undefined = vscode.workspace.getConfiguration('vsquirrel').get("squirrelPath");
				debugChannel.appendLine(`Configuration: ${vscode.workspace.getConfiguration('vsquirrel').get("lsp.pythonInterpreterPath")} ||| ${vscode.workspace.getConfiguration('vsquirrel').get("squirrelPath")}`);
				if (configSquirrelPath2 !== undefined) {
					squirrelPath = configSquirrelPath2;
				} else {
					squirrelPath = "~/squirrel-prover/squirrel";
				}
				debugChannel.appendLine(`Path to squirrel before sending to LSP: ${squirrelPath}`);
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
					proofState.refreshHighlights();
					if (minimalModifiedPoint.isBefore(proofState.endProofPosition)) {
						proofState.interpretToPosition(minimalModifiedPoint, false);
					}
				}
			}
		},
	);

	// vscode.window.onDidChangeTextEditorSelection(
	// 	(event: vscode.TextEditorSelectionChangeEvent) => {
	// 		const proofState : SquirrelDocumentProofState | undefined = proofStates.get(event.textEditor.document.fileName);
	// 		if (proofState !== undefined) {
	// 			let minimalModifiedPoint : vscode.Position | undefined = undefined;
	// 			for (let contentChange of event.contentChanges) {
	// 				if (minimalModifiedPoint === undefined) {
	// 					minimalModifiedPoint = contentChange.range.start;
	// 				} else {
	// 					if (minimalModifiedPoint.isAfter(contentChange.range.start)) {
	// 						minimalModifiedPoint = contentChange.range.start;
	// 					}
	// 				}
	// 			}
	// 			if (minimalModifiedPoint !== undefined) {
	// 				if (minimalModifiedPoint.isBefore(proofState.endProofPosition)) {
	// 					proofState.interpretToPosition(minimalModifiedPoint, false);
	// 				}
	// 			}
	// 		}
	// 	},
	// );

	context.subscriptions.push(startProofCmd);
	context.subscriptions.push(closeProofCmd);
	context.subscriptions.push(nextProofCmd);
	context.subscriptions.push(undoProofCmd);
	context.subscriptions.push(goToProofCmd);
	context.subscriptions.push(killServer);
}

// This method is called when your extension is deactivated
export function deactivate() {
	lsp_server.kill();
}
