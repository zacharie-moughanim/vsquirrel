import * as vscode from 'vscode';

export enum nextDotError {
	noDot,
	invalidComment
}

/** Returns next valid position after [from] in [doc]. It may add a line if the position is at the end of a line.
 *  Returns [undefined] if [from] is the last valid position in [doc].  */
export function nextCharacterPosition(doc : vscode.TextDocument, from : vscode.Position) : vscode.Position | undefined {
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
export function prevCharacterPosition(doc : vscode.TextDocument, from : vscode.Position) : vscode.Position | undefined {
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
export function findNextDot(doc : vscode.TextDocument, from : vscode.Position) : vscode.Position | nextDotError {
	var prevChar : string;
	var curChar : string = "";
	var curPos : vscode.Position = from;
	var nextPos : vscode.Position | undefined;
	var withinComment : boolean = false; // invariant: withinComment == (commentDepth > 0)
	var commentDepth : number = 0;
	do {
		if (commentDepth < 0) {
			return nextDotError.invalidComment;
		}
		nextPos = nextCharacterPosition(doc, curPos);
		if (nextPos === undefined) {
			return nextDotError.noDot;
		}
		prevChar = curChar;
		curChar = doc.getText(new vscode.Range(curPos, nextPos));
		curPos = nextPos;
		if (prevChar === "*" && curChar === ")") {
			--commentDepth;
		} else if (prevChar === "(" && curChar === "*") {
			++commentDepth;
		}
	} while (!(curChar === '.' && !(commentDepth > 0)));
	return nextPos;
}

export function findPrevDot(doc : vscode.TextDocument, from : vscode.Position) : vscode.Position | undefined {
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

/**
 * `countDotBetween(doc, from, to)` returns the number of (out of comments) dot found between `from` and `to` in `doc`.`
 */
export function countDotBetween(doc : vscode.TextDocument, from : vscode.Position, to : vscode.Position) : number {
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

// type Tail<T> =	T extends [infer X, ...infer XS] ? XS : never

// /** `Occurrences<[string, ..., string]> = [vscode.Range[], ..., vscode.Range[]]` with as many `vscode.Range[]` as there are `string` in the argument.  */
// type SameLengthArray<T, Y> = { [I in keyof T] : Y };

// function mapTypeSafe<T extends SameLengthArray<T, X>, X, Y>(arr : T, callbackfn: (value : X, index: number, array: X[]) => Y) : SameLengthArray<T, X> {
// 	let x : SameLengthArray<T, X> =  arr;
// 	x.set(0, x);
// 	return x;
// }

/** Returns the vscode range corresponding to a chunk of length `chunkLength` starting from
 * `chunkLineOffset` and `chunkStartCharOffset` within the range Range(startPos, endPos)
 * 
 * ⚠️ Only works if the chunk is on a single line ⚠️
 * 
 * Example: assume we have startPos0 = Position(1, 2) and endPos0 = Position(3, 4) and `document`
 * designate a document whose text is:
 * 
 * ############ document ############
 * 
 * Some text on several line in
 * 
 * a file, which is great since
 * 
 * I have an example to give in
 * 
 * this function's description
 * 
 * which is getting more and more
 * 
 * obscure.
 * 
 * ##################################
 * 
 * let `range_a = getRangeOfChunkWithin(2, 3, 3, startPos0, endPos0)`
 * then `document.getText(range_a)` returns `"s f"`
 * let `range_b = getRangeOfChunkWithin(0, 3, 3, startPos0, endPos0)`
 * then `document.getText(range_b)` returns `"e, "` */
export function getRangeOfChunkWithin(chunkLineOffset : number, chunkStartCharOffset : number, chunkLength : number, startPos : vscode.Position) : vscode.Range {
	if (chunkLineOffset === 0) {
		return new vscode.Range(
			new vscode.Position(startPos.line, startPos.character + chunkStartCharOffset),
			new vscode.Position(startPos.line, startPos.character + chunkStartCharOffset + chunkLength)
		);
	} else {
		return new vscode.Range(
			new vscode.Position(startPos.line + chunkLineOffset, chunkStartCharOffset),
			new vscode.Position(startPos.line + chunkLineOffset, chunkStartCharOffset + chunkLength)
		);
	}
}

// Searching substring while maitaining document's positions of found pattern 
/** Finds all occurences of each pattern in `patterns` in `text`.
 * Assuming the `text` comes from a range of a document whose end is `endTextPos`,
 * returns a list of ranges where each occurrence of each pattern appears.
 * Example: substringSearchWithPosition("foo\nbar foo", new Position(2, 6), [foo, bar]) returns
 * 		[
 * 			[ {(1,0)..(1,3)}, {(2,4)..(2,6)} ],
 * 			[ {(2,0)..(2,3)} ]
 * 		]
*/
export function substringSearchWithPosition<T extends string[]>(text : string, startTextPos : vscode.Position, patterns : T) : vscode.Range[][] {
	let textLines = text.split("\n");
	let nLines = textLines.length;
	let res : vscode.Range[][] = patterns.map((it : string) : vscode.Range[] => []);
	for (let [iLine, line] of text.split("\n").entries()) {
		for (let [iChar, c] of line.split("").entries()) {
			for (let [iPat, pat] of patterns.entries()) {
				if (iChar + pat.length < line.length) {
					if (line.substring(iChar, iChar + pat.length) === pat) {
						res.at(iPat)?.push(
							getRangeOfChunkWithin(iLine, iChar, pat.length, startTextPos)
						);
					}
				}
			}
		}
	}
	return res;
}