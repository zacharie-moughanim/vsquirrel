# VSquirrel

VScod{e,ium} extension for [Squirrel proof assistant](https://squirrel-prover.github.io/).

## Features

- Syntax highlighting for Squirrel (.sp) files;
- start and manage proofs interactively on a given file (a proof can be started on several files at a time).

The extension bundles a [LSP server](https://github.com/zacharie-moughanim/pysquirrel-prover-lsp) to manage proofs via squirrel's interactive mode.

## Installation guide

+ You first need to install the Squirrel prover. You can follow installation instructions [here](https://github.com/squirrel-prover/squirrel-prover/#installation).
+ You also need a python interpreter.
+ You need to install the extension from the marketplace. E.g.via the commande palette (F1) then "Extensions: Install Extensions" and search "vsquirrel" or "vsquirrel prover".
+ Finally, you need to setup paths so the extension can interact with squirrel. In the extension settings:
  + Set "Lsp: Python Interpreter Path" to a path to python, it's probably `python` or `python3`.
  + Set "Squirrel Path" to the path to (the compiled file) squirrel, if you followed the installation instructions for squirrel, you can find with the command `which squirrel`. Write the full path without abbreviations: not `squirrel` or `~/squirrel`, but rather `/path/to/squirrel`.

Try the extension by starting a proof (Command Palette: "Squirrel Prover: Start Proof" or the 'run' button) in a ".sp" file, see [here](#troubleshooting) if you get errors. See [the Get Started section](#get-started) for details of commands to manage proofs. Please report any bug to [the repository](https://github.com/zacharie-moughanim/vsquirrel/issues).

## Get started

When focused on a squirrel file, you can use the `Start Proof` command (via the command palette "Squirrel Prover: StartProof" or by pressing the 'run' button).

Once a proof is started on a file, you can navigate in the file with the following commands:
- `nextProof` (default: `alt+down` or `ctrl+alt+down` on mac): interpret the next command (up until the next dot) in the current proof.
- `goToProof` (default: `alt+right` or `ctrl+alt+right` on mac): interpret all commands up until current cursor's position.
- `undoProof` (default: `alt+up` or `ctrl+alt+up` on mac): undoes the last processed command.
- `closeProof` ("Squirrel Prover: Close Proof" in command palette, 'stop' button in toolbar): closes a proof.

## Extension Settings

There are two settings necessary for the extension to work:
- the path to the compiled squirrel file. Once squirrel is installed and compiled, you can find the path with the command `which squirrel`;
- the path to a python interpreter. If you have python installed, it's probably `python` or `python3`.

Here are the other customization settings that are not required for the extension to work:
- Whether or not to highlight processed `admit` commands.
- Whether or not to highlight processed `Abort` commands.
- The font size of the proof state in webview (goals, etc, that appear on the right handside panel).

## Extension Colors

The extension provides colors, which can be modified in `Settings > Color Customization`, corresponding to the highlight's color on an ongoing proof:
- a color for processed proof `vsquirrel.proof.processed`;
- a color for proof in processing `vsquirrel.proof.processing`;
- a color for a command that triggered an error `vsquirrel.proof.error`.
The two following highlighting can be disabled [in the settings](#extension-settings).
- a color for highlighting `admit`s in a processed command `vsquirrel.proof.admit`.
- a color for highlighting `abort`s in a processed command `vsquirrel.proof.abort`.

## Troubleshooting

- If you get an error on extension's activation, this may be caused by a wrong path to python, check it in the extension's setting.
- If you get an error when starting a proof, this may be caused by:
  - a wrong path to squirrel, check it in the extension's setting;
  - or try to enter a full path to squirrel's executable rather than just `squirrel` or `~/squirrel`. You can find the full path with the command `which squirrel` if `squirrel` is in the PATH environment variable.

## Known Issues

- Using the `undo` command directly in a file (e.g. writing `undo 3.` and processing this command via VSquirrel) may lead to errors, for a safe execution, use only `Undo last proof command` provided by VSquirrel.
- Text colors (for squirrel's response in webview) are hard-coded (with variant for dark/light theme).
- Only one command can be in processing at a time, for now.
- Squirrel has a HTML export, though not directly accessible via the CLI in interactive mode, whereas the extension transforms the prompt output of squirrel into HTML.
