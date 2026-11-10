import * as vscode from 'vscode';

import { string_of_position, string_of_positions, unpack } from './utils';
import {
	nextCharacterPosition,
	prevCharacterPosition,
	nextDotError,
	findNextDot,
	findPrevDot,
	countDotBetween,
	getRangeOfChunkWithin,
	substringSearchWithPosition
} from './documentNavigation';

/// PROOFS STATE

// Position of the beginning of the document, of the last point requested to be processed, and of the last point where the proof was processed.
const startDocumentPosition = new vscode.Position(0, 0);

// Decorations
var processingProofColor = new vscode.ThemeColor("vsquirrel.proof.processing");
var processedProofColor = new vscode.ThemeColor("vsquirrel.proof.processed");
var processedErrorProofColor = new vscode.ThemeColor("vsquirrel.proof.error");
var processedAdmitProofColor = new vscode.ThemeColor("vsquirrel.proof.admit");
var processedAbortProofColor = new vscode.ThemeColor("vsquirrel.proof.abort");

class commandWaitingForProcessingData {
	command : string;
	startPos : vscode.Position;
	endPos : vscode.Position; // Keeping startPos/endPos for now for retrocompatibility. TODO At some point replace with a single range.

	constructor(cmd : string, startPos : vscode.Position, endPos : vscode.Position) {
		this.command = cmd;
		this.startPos = startPos;
		this.endPos = endPos;
	}
}

class commandBuffer { // TODO implement a more efficient queue
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

export class SquirrelDocumentProofState {
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
	admitRanges : vscode.Range[];
	abortRanges : vscode.Range[];
	highlightAdmit : boolean;
	highlightAbort : boolean;
	/**
	 * Whether a command was sent to the LSP server and we're waiting for a response.
	 * INVARIANT: waitingForProofProcessing === (commandSentToLSP !== undefined)
	 */
	waitingForProofProcessing : boolean;
	/** List of command that are waiting to be processed (e.g. after an interpretToPosition) */
	commandsWaitingQueue : commandBuffer;
	/** The command sent to LSP server for which no response has been received yet, if any.
	 * If it's a number, then it corresponds to an `undo` and the value is the argument of `undo`
	 * Otherwise, the value is a pair of:
	 * - the last position of the the range from which the command comes;
	 * - [admitRanges, abortRanges], ranges corresponding to the occurences of admit and abort in the command.
	 */
	commandSentToLSP : [vscode.Position, [vscode.Range[], vscode.Range[]]] | number | undefined;
	// Decorations
	decorationProcessingProof : vscode.TextEditorDecorationType;
	decorationProcessedProof : vscode.TextEditorDecorationType;
	decorationErrorProof : vscode.TextEditorDecorationType;
	decorationAdmitProof : vscode.TextEditorDecorationType;
	decorationAbortProof : vscode.TextEditorDecorationType;

	webviewFontSize : number;
  // External interaction handles
  send : ((msg : Object) => void);
  logError : ((msg : string) => void);

	closing : boolean;

	/** coucou */
	constructor(
		editor : vscode.TextEditor,
		proofPanel : vscode.WebviewPanel,
    sendHandle : ((msg : Object) => void),
    logErrorHandle : ((msg : string) => void),
		webviewFontSize : number = 12,
		endPos : vscode.Position = new vscode.Position(0, 0),
		lastProcessedPos = new vscode.Position(0, 0),
		waitingForProofProcessing = false,
		decorationProcessingProof = vscode.window.createTextEditorDecorationType({
      backgroundColor : processingProofColor,
      rangeBehavior : vscode.DecorationRangeBehavior.ClosedClosed
    }),
		decorationProcessedProof = vscode.window.createTextEditorDecorationType({
      backgroundColor : processedProofColor,
      rangeBehavior : vscode.DecorationRangeBehavior.ClosedClosed
    }),
		decorationErrorProof = vscode.window.createTextEditorDecorationType({
      backgroundColor : processedErrorProofColor,
      rangeBehavior : vscode.DecorationRangeBehavior.ClosedClosed
    }),
		decorationAdmitProof = vscode.window.createTextEditorDecorationType({
      backgroundColor : processedAdmitProofColor,
      rangeBehavior : vscode.DecorationRangeBehavior.ClosedClosed
    }),
		decorationAbortProof = vscode.window.createTextEditorDecorationType({
      backgroundColor : processedAbortProofColor,
      rangeBehavior : vscode.DecorationRangeBehavior.ClosedClosed
    })
	) {
		this.editor = editor;
		this.proofPanel = proofPanel;

		this.proofStateMain = [];
		this.proofStateResponses = [];

		this.endProofPosition = endPos;
		this.lastProcessedProofPosition = lastProcessedPos;
		this.waitingForProofProcessing = waitingForProofProcessing;
		this.lastProcessedProofPositionHistoric = [this.lastProcessedProofPosition];
		this.admitRanges = [];
		this.abortRanges = [];
		this.commandsWaitingQueue = new commandBuffer();

		this.decorationProcessingProof = decorationProcessingProof;
		this.decorationProcessedProof = decorationProcessedProof;
		this.decorationErrorProof = decorationErrorProof;
		this.decorationAdmitProof = decorationAdmitProof;
		this.decorationAbortProof = decorationAbortProof;

		this.webviewFontSize = webviewFontSize;
		
		const mayHighlightAdmit : boolean | undefined = vscode.workspace.getConfiguration('vsquirrel').get("highlightAdmit") ;
		const mayHighlightAbort : boolean | undefined = vscode.workspace.getConfiguration('vsquirrel').get("highlightAbort") ;

		if (mayHighlightAdmit === undefined) {
			this.highlightAdmit = true;
		} else {
			this.highlightAdmit = mayHighlightAdmit;
		}

		if (mayHighlightAbort === undefined) {
			this.highlightAbort = true;
		} else {
			this.highlightAbort = mayHighlightAbort;
		}

		this.closing = false;

    this.send = sendHandle;
    this.logError = logErrorHandle;
	}

	// positions setters and modifiers.

	public refreshEndProofPosition() {
		if (this.lastErrorProofPosition === undefined) {
			if (this.lastProcessingProofPosition === undefined) {
				this.endProofPosition = this.lastProcessedProofPosition;
			} else {
				if (this.lastProcessingProofPosition.isBefore(this.lastProcessedProofPosition)) {
					this.logError("PANIC invariant on positions");
					this.endProofPosition = this.lastProcessedProofPosition;
				} else {
					this.endProofPosition = this.lastProcessingProofPosition;
				}
			}
		} else {
			if (this.lastProcessingProofPosition !== undefined) {
				this.logError("PANIC invariant on positions ");
			} else {
				if (this.lastErrorProofPosition.isBefore(this.lastProcessedProofPosition)) {
					this.logError("PANIC invariant on positions");
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
		} else {
			this.lastProcessedProofPositionHistoric.pop();
			const posToRestore = this.lastProcessedProofPositionHistoric.at(-1);
			if (posToRestore === undefined) {
				vscode.window.showErrorMessage("panic. not supposed to happen because we're in the else branch of the condition above.");
			} else {
				this.lastProcessedProofPosition = posToRestore; // Correct even if .at returns [undefined]
				// Removing abort and admit ranges occurring after the new `lastProcessedProofPosition`
				while (this.abortRanges.at(-1)?.end.isAfter(this.lastProcessedProofPosition)) {
					this.abortRanges.pop();	
				}
				while (this.admitRanges.at(-1)?.end.isAfter(this.lastProcessedProofPosition)) {
					this.admitRanges.pop();	
				}
			}
			this.refreshEndProofPosition();
		}
	}

	/**
	 * Re-establish positions to the state it was before the last processed command.
	 */
	public undoPositions() {
		if (this.lastProcessingProofPosition !== undefined) {
			this.logError("PANIC. Trying to undo positions while a command is in processing.");
		} else {
			if (this.endProofPosition === this.lastProcessedProofPosition) {
				this.undoLastProcessedProofPosition();
				this.endProofPosition = this.lastProcessedProofPosition;
			} else if (this.endProofPosition === this.lastErrorProofPosition) {
				this.lastErrorProofPosition = undefined;
				this.endProofPosition = this.lastProcessedProofPosition;
			} else {
				this.logError("PANIC. Invariant on positions is false.");
			}
		}
	}

	public clearError() {
		this.updateLastErrorProofPosition(undefined);
	}

	public addAbortRanges(abortRanges : vscode.Range[]) {
		this.abortRanges.push(...abortRanges);
	}

	public addAdmitRanges(admitRanges : vscode.Range[]) {
		this.admitRanges.push(...admitRanges);
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
		this.editor.setDecorations(this.decorationAbortProof, this.abortRanges);
		this.editor.setDecorations(this.decorationAdmitProof, this.admitRanges);
	}

	/// Returns proof states in an HTML page, adapted to display in a webview.
	public updateProofStateInWebview() : void {
		let HTMLProofStateResponses : string = "";
		let HTMLProofMain : string = "";
		let CSSColorStart : string;
		let CSSColorWarning : string;
		let CSSColorError : string;
		if (vscode.window.activeColorTheme.kind === vscode.ColorThemeKind.Dark || vscode.window.activeColorTheme.kind === vscode.ColorThemeKind.HighContrast) {
			CSSColorStart = "#a8fcff"; // TODO see if we can instead use vscode.ThemeColor
			CSSColorWarning = "#ffe605";
			CSSColorError = "#f00000";
		} else {
			CSSColorStart = "#0a39a0ff";
			CSSColorWarning = "#965500ff";
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
		const fontSizeStyle = (
			this.webviewFontSize === undefined ?
				"" :
				`#main, #responses {
					font-size: ${this.webviewFontSize}pt;
				}`
		);
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
			// Not sure the following assignation is useful.
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
					height: 98vh;
				}
				${fontSizeStyle}
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

	/** `processNextWaitingCommand()` sends to LSP the next command in `commandsWaitingQueue` if any, and marks it 
	 * as the command for which an answer from the LSP is expected.
	 */
	private processNextWaitingCommand() {
		if (this.commandsWaitingQueue.isEmpty()) {
			this.commandSentToLSP = undefined;
		} else {
			const mayNextCommand : commandWaitingForProcessingData | undefined = this.commandsWaitingQueue.dequeue();
			if (mayNextCommand === undefined) {
				this.logError("PANIC.");
			} else {
				const nextCommand : string = mayNextCommand.command;
				this.send({method: "pysquirrellsp/proofCommand", proofCommand: nextCommand, documentId: this.editor.document.fileName});
				this.waitingForProofProcessing = true;
				if (this.highlightAbort && this.highlightAdmit) {
					let mayAdmitAbortRanges : vscode.Range[][] = substringSearchWithPosition(nextCommand, mayNextCommand.startPos, ["admit", "Abort"]);
					let admitAbortRanges : [vscode.Range[], vscode.Range[]] = [unpack(mayAdmitAbortRanges.at(0), []), unpack(mayAdmitAbortRanges.at(1), [])];
					this.commandSentToLSP = [mayNextCommand.endPos, admitAbortRanges];
				} else if (this.highlightAdmit) {
					let mayAdmitAbortRanges : vscode.Range[][] = substringSearchWithPosition(nextCommand, mayNextCommand.startPos, ["admit"]);
					let admitAbortRanges : [vscode.Range[], vscode.Range[]] = [unpack(mayAdmitAbortRanges.at(0), []), []];
					this.commandSentToLSP = [mayNextCommand.endPos, admitAbortRanges];
				} else if (this.highlightAbort) {
					let mayAdmitAbortRanges : vscode.Range[][] = substringSearchWithPosition(nextCommand, mayNextCommand.startPos, ["Abort"]);
					let admitAbortRanges : [vscode.Range[], vscode.Range[]] = [[], unpack(mayAdmitAbortRanges.at(0), [])];
					this.commandSentToLSP = [mayNextCommand.endPos, admitAbortRanges];
				} else {
					this.commandSentToLSP = [mayNextCommand.endPos, [[], []]];
				}
			}
		}
	}

	/**
	 * `commandResponseReceived(error, moveCursor)` manages a received response for a sent command.
	 * Basically, it displays visually that the command was processed.
	 * @param error whether the response indicated that an error occured during command processing.²a
	 */
	public commandResponseReceived(error : boolean = false, moveCursor : boolean = false) {
		// if (DEBUG_MODE) {
		// 	debugChannel.appendLine(`BEFORE: lastProcessed: ${string_of_position(this.lastProcessedProofPosition)} ||| historic: ${string_of_positions(this.lastProcessedProofPositionHistoric)}\nlastProcessing: ${string_of_position(this.lastProcessingProofPosition)}\nlastError: ${string_of_position(this.lastErrorProofPosition)}\nend: ${string_of_position(this.endProofPosition)}`);
		// }
		const mayCorrespondingCommand : [vscode.Position, [vscode.Range[], vscode.Range[]]] | number | undefined = this.commandSentToLSP;
		if (mayCorrespondingCommand === undefined) {
			this.logError("Panic. Received response to a command while no command was sent.");
		} else {
			const correspondingCommand : [vscode.Position, [vscode.Range[], vscode.Range[]]] | number = mayCorrespondingCommand;
			if (typeof correspondingCommand === "number") {
				// Data is a number, corresponding to an `undo` command.
				// We (visually) undo nUndos commands: update positions and move cursor to new end position.
				let nUndos : number = correspondingCommand;
				for (let i = 0; i < nUndos; ++i) {
					this.undoPositions();
				}
				if (moveCursor) {
					this.moveCursorToEnd();
				}
			} else {
				// Data corresponds to a command
				let [newLastPos, [admitRanges, abortRanges]] = correspondingCommand;
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
					this.addAdmitRanges(admitRanges);
					this.addAbortRanges(abortRanges);
				}
			}
			this.waitingForProofProcessing = false;
			// If there are still command waiting to be processed, we process the next one.
			this.processNextWaitingCommand();
		}
		// if (DEBUG_MODE) {
		// 	debugChannel.appendLine(`AFTER: lastProcessed: ${string_of_position(this.lastProcessedProofPosition)} ||| historic: ${string_of_positions(this.lastProcessedProofPositionHistoric)}\nlastProcessing: ${string_of_position(this.lastProcessingProofPosition)}\nlastError: ${string_of_position(this.lastErrorProofPosition)}\nend: ${string_of_position(this.endProofPosition)}`);
		// }
	}

	/** `processCommands(commands)` sends to LSP server each command in `commands`, it updates the positions and the highlighting. */
	private processCommands(commands : [string, vscode.Range][]) {
		for (let [cmd, range] of commands) {
			this.commandsWaitingQueue.enqueue(new commandWaitingForProcessingData(cmd, range.start, range.end));
			this.updateLastProcessingProofPosition(range.end);
		}
		const previouslyWaitingForProofProcessing : boolean = this.waitingForProofProcessing;
		const lastCmd : [string, vscode.Range] | undefined = commands.at(-1);
		if (lastCmd !== undefined) { // If there is at least one command to process
			this.waitingForProofProcessing = true;
			// Visual update of proof in processing
			this.refreshHighlights();
			this.moveCursorToEnd();
			// If no proof command was on the fly, actually send next command to LSP
			if (!previouslyWaitingForProofProcessing) {
				this.processNextWaitingCommand();
			}
		}
	}

	/** nextProof() sends to the LSP server the command between [this.lastProcessedProofPosition] and the position of the next dot (out of comment).
	 */
	public nextProof() {
		if (this.waitingForProofProcessing) {
			// TODO authorizing the processing of several command may lead to errors, for now let's keep that and see if we can lift the restriction in the future. 
			vscode.window.showErrorMessage("VSquirrel: Wait for last command to be processed."); // TODOTODO
		} else {
			// Searching command between the last position of the proof to next dot.
			// The last position may be `lastProcessedProofPosition` or `lastProcessingProofPosition` if the latter is defined.
			let fromPos : vscode.Position = this.lastProcessedProofPosition;
			let processingPos : vscode.Position | undefined = this.lastProcessingProofPosition;
			if (processingPos !== undefined) {
				fromPos = processingPos;
			}
			const nextDotPosition : vscode.Position | nextDotError = findNextDot(this.editor.document, fromPos);
			if (nextDotPosition === nextDotError.noDot) {
				vscode.window.showErrorMessage("VSquirrel: No dot to get the proof to in the remaining of the document.");
			} else if (nextDotPosition === nextDotError.invalidComment) {
				vscode.window.showErrorMessage("VSquirrel: Invalid closing comment before next dot.");
			} else {
				const cmdRange : vscode.Range = new vscode.Range(this.lastProcessedProofPosition, nextDotPosition);
				const bufferProof : string = this.editor.document.getText(cmdRange);
				this.processCommands([[bufferProof, cmdRange]]);
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
			this.logError("PANIC. `undoCommands` has been called while `waitingForProofProcessing` is `true`");
		} else {
			this.waitingForProofProcessing = true;
			this.commandSentToLSP = n;
			let msg : any = {method:"pysquirrellsp/proofCommand", proofCommand: `undo ${n}.`, documentId: this.editor.document.fileName};
			if (moveCursor) {
				msg = {method:"pysquirrellsp/proofCommand", proofCommand: `undo ${n}.`, documentId: this.editor.document.fileName, moveCursor: moveCursor};
			}
			this.send(msg);
			this.commandsWaitingQueue.clear();
		}
	}

	/**
	 * undo last command.
	 */
	public undoProof() {
		if (this.waitingForProofProcessing) {
			// TODO authorizing the processing of several command may lead to errors, for now let's keep that and see if we can lift the restriction in the future. 
			vscode.window.showErrorMessage("VSquirrel: Wait for last command to be processed."); // TODOTODO
		} else {
			// If the last command resulted in an error, it is not to undo since it did not produce any result.
			if (this.lastErrorProofPosition === undefined) {
				if (findPrevDot(this.editor.document, this.lastProcessedProofPosition) === undefined) {
					vscode.window.showErrorMessage("VSquirrel: No proof command to undo.");
				} else {
					this.undoCommands(1, true);
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
			vscode.window.showErrorMessage("VSquirrel: Wait for last command to be processed."); // TODOTODO
		} else {
			// If the position is before the last processed point, we undo some commands, otherwise we process some more commands.
			if (pos.isBefore(this.lastProcessedProofPosition)) {
				let nToUndo : number = 0;
				for (let i = this.lastProcessedProofPositionHistoric.length - 1; i >= 0; --i) {
					const pastProcessedProofPos = this.lastProcessedProofPositionHistoric.at(i);
					if (pastProcessedProofPos === undefined) {
						this.logError("Panic. Out of bounds in proof position historic.");
					} else {
						if (pos.isBefore(pastProcessedProofPos)) {
							++nToUndo;
						} else {
							break;
						}
					}
				}
				this.undoCommands(nToUndo, moveCursor);
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
					let commands : [string, vscode.Range][] = [];
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
								const cmdRange = new vscode.Range(lastCommandBeginningPos, nextPos);
								commands.push([this.editor.document.getText(cmdRange), cmdRange]);
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