import * as vscode from 'vscode';
// Debug pretty-printing

export function string_of_position(pos : vscode.Position | undefined) : string {
  if (pos === undefined) {
    return "undefined";
  } else {
    return `(l. ${pos.line}, c. ${pos.character})`;
  }
}

export function string_of_positions(poses : (vscode.Position | undefined)[]) : string {
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

/** `unpack(x, def) = x` if `x` is not `undefined` and is `def` otherwise. */
export function unpack<T>(x : T | undefined, def : T) : T {
  if (x === undefined) {
    return def;
  } else {
    return x;
  }
}