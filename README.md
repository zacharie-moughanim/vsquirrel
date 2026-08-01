# VSquirrel

VScod{e,ium} extension for [Squirrel proof assistant](https://squirrel-prover.github.io/).

## Features

- Syntax highlighting for Squirrel (.sp) files;
- start and manage proofs on a given file (a proof can be started on several files at a time).

The extension bundles a [LSP server](https://github.com/zacharie-moughanim/pysquirrel-prover-lsp) to manage proofs via squirrel's interactive mode.

## Get started

When focused on a squirrel file, you can use the `Start Proof` command (via the command palette or by pressing the run button), then you can navigate in the file with `nextProof`, etc. See all commands in `Features > Commands`.

## Requirements

Once these are installed, [check here to set up the extension.](#extension-settings).

- Squirrel proof assistant follow the installation guide on [squirrel's repository](https://github.com/squirrel-prover/squirrel-prover/#readme).
- A python interpreter.

## Extension Settings

There are two settings necessary for the extension to work:
- the path to the compiled squirrel file;
- the path to a python interpreter.

## Extension Colors

The extension provides three colors, which can be modified in `Settings > Color Customization`, corresponding to the highlight's color on an ongoing proof:
- a color for processed proof `vsquirrel.proof.processed`;
- a color for proof in processing `vsquirrel.proof.processing`;
- a color for a command that triggered an error `vsquirrel.proof.error`.

## Known Issues

- Using the `undo` command directly in a file (e.g. writing `undo 3.` and processing this command via VSquirrel) may lead to errors, for a safe execution, use only `Undo last proof command` provided by VSquirrel.
- If you get an error on extension's activation, this may be caused by a wrong path to python, check it in the extension's setting.
- If you get an error when starting a proof, this may be caused by a wrong path to squirrel, check it in the extension's setting.
- Text colors (for squirrel's response in webview) are hard-coded (with variant for dark/light theme).
- Only one command can be in processing at a time, for now.
- Squirrel has a HTML export, though not directly accessible via the CLI in interactive mode, whereas the extension transforms the prompt output of squirrel into HTML.