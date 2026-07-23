# VSquirrel

VScod{e,ium} extension for Squirrel proof assistant

## Features

## Requirements

- [Squirrel proof assistant](https://github.com/squirrel-prover/squirrel-prover)
- A python interpreter

## Extension Settings

There are two settings necessary for the extension to work:
- the path to the compiled squirrel file;
- the path to a python interpreter.

## Known Issues

- Modifying in the processed part of a file must undo until the modified part.
- Squirrel has a HTML export, though not directly accessible via the CLI in interactive mode, whereas the extension transforms the prompt output of squirrel into HTML.
- No syntax highlighting + maybe reuse directly squirrel's lexer with semantic highlighting.
- Add color of proof highlighting in configuration.

## Release Notes

### 0.0.1