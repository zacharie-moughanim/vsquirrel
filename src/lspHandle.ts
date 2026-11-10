import * as vscode from 'vscode'; 
import { spawn, ChildProcess } from 'child_process';
import { TextEncoder } from "node:util";
var ConvertANSIToHTML = require('ansi-to-html');

import { SquirrelDocumentProofState } from './proofState';

/** A LSPHandle instance manages a LSP process and all proof states currently
 * run on this process.
  */
export class LSPHandle {
  lspProcess : ChildProcess;
  lastMsgIdx : number;
  private bufStdout : string;
  private bufStderr : string;
  private logErrorHandle : ((msg : string) => void);
  private DEBUG_MODE;
  /* TODO should be private */proofStates : Map<string, SquirrelDocumentProofState>;
  private foregroundWebviewColor : string;
  private ANSItoHTMLConverter;
  constructor(
    pythonPath : string,
    LSPServerWorkDir : string,
    LSPServerStartCLOptions : string[],
    logErrorHandle : ((msg : string) => void),
    DEBUG_MODE : boolean = false
  ) {
    this.lspProcess = spawn(pythonPath, LSPServerStartCLOptions, { "cwd": LSPServerWorkDir });
    this.lastMsgIdx = 0;
    this.bufStdout = "";
    this.bufStderr = "";

    this.logErrorHandle = logErrorHandle;
    this.DEBUG_MODE = DEBUG_MODE;

    this.proofStates = new Map();

    this.foregroundWebviewColor = "#FFF";
    this.ANSItoHTMLConverter = new ConvertANSIToHTML({
      fg: this.foregroundWebviewColor,
      newline: true,
      escapeXML: true
    });

    if (this.lspProcess.stdout !== null) {
      this.lspProcess.stdout.setEncoding("utf8");
      this.lspProcess.stdout.on('data', (data : string) => {
        this.bufStdout += data;
        if (this.DEBUG_MODE) {
          this.logErrorHandle(`==stdout==\n${data}\n==end stdendout==`);
        }
        // Parsing buffer. It may contain several chunks of the form HEADER\r\nAJSONOBJECT. We read all such chunks and pass them to LSPRecvStdout
        let stillDataToParse : boolean = true;
        while (stillDataToParse) {
          stillDataToParse = false;
          let contentLength : number | undefined = undefined;
          const contentlengthFieldTitle = "Content-Length:";
          const lines_stdout = this.bufStdout.split("\n");
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
              this.LSPRecvStdout(rest.substring(0, contentLength));
              this.bufStdout = rest.substring(contentLength);
            }
          }
        }
      });
    } else {
      this.logErrorHandle(`LSP server: stdout undefined`);
    }
  
    if (this.lspProcess.stderr !== null) {
      this.lspProcess.stderr.setEncoding("utf8");
      this.lspProcess.stderr.on('data', (data : string) => {
        this.bufStderr += data;
        if (this.DEBUG_MODE) {
          this.logErrorHandle(`==stderr==\n${data}\n==end stderr==`);
        }
        // Parsing buffer. It may contain several chunks of the form HEADER\r\nAJSONOBJECT. We read all such chunks and pass them to LSPRecvStderr
        let stillDataToParse : boolean = true;
        while (stillDataToParse) {
          stillDataToParse = false;
          let contentLength : number | undefined = undefined;
          const contentlengthFieldTitle = "Content-Length:";
          const lines_stderr = this.bufStderr.split("\n");
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
              this.LSPRecvStderr(rest.substring(0, contentLength));
              this.bufStderr = rest.substring(contentLength);
            }
          }
        }
      });
    } else {
      this.logErrorHandle(`LSP server: stderr undefined`);
    }
  
    this.lspProcess.on('close', (code : number, signal : string) => {
      if (signal !== null) {
        vscode.window.showErrorMessage(`VSquirrel: LSP server exited with code ${code} and signal ${signal}`);
        console.log(`LSP server exited with code ${code} and signal ${signal}`);
      } else {
        vscode.window.showErrorMessage(`VSquirrel: LSP server exited with code ${code}`);
        console.log(`LSP server exited with code ${code}`);
      }
    });
  
    this.lspProcess.on('error', (err : Error) => {
      vscode.window.showErrorMessage(`VSquirrel: LSP server error: ${err}`);
      console.error(`LSP server error: ${err}`);
    });
  }
  
  /** Sends [msg] to LSP server, computing header on [data] 
   */
  public LSPSend(obj : object, withUniqueId : boolean = false) {
    if (this.lspProcess.stdin === null) {
      this.logErrorHandle("LSP server: stdin undefined while sending.");
    } else {
      if (withUniqueId) {
        var obj2 : any = obj; // TODO see if there's no better option (intermediary variable because of cast typing issue)
        obj2.id = this.lastMsgIdx;
        this.lastMsgIdx += 1;
      }
      // this.lspProcess.stdin.write(msg_with_header);
      const data : string = JSON.stringify(obj2);
      const encoder = new TextEncoder();
      this.lspProcess.stdin.setDefaultEncoding("utf-8");
      const encoded_msg_payload = encoder.encode(data);
      const msg_header = `Content-Length: ${encoded_msg_payload.length}\r\n\r\n`;
      this.lspProcess.stdin.write(encoder.encode(msg_header));
      this.lspProcess.stdin.write(encoded_msg_payload);
      if (this.DEBUG_MODE) {
        this.logErrorHandle(`==== Sent ====\n${msg_header}${data}\n============`);
      }
    }
  }

  public LSPRecvStdout(data : string) : void {
    const objRcvd = JSON.parse(data);
    if (Object.hasOwn(objRcvd, "method")) {
      if (objRcvd.method === "pysquirrellsp/squirrelProofOutput") {
        if(!(Object.hasOwn(objRcvd, "kind"))) {
          vscode.window.showErrorMessage("Received LSP message without expected field [kind].");
        } else {
          if(!(Object.hasOwn(objRcvd, "documentId"))) {
            vscode.window.showErrorMessage("Received LSP message without expected field [kind].");
          } else {
            let proofState = this.proofStates.get(objRcvd.documentId);
            if (proofState === undefined) {
              vscode.window.showErrorMessage("Panic: LSP server mentions a closed or nonexistent file.");
            } else {
              const moveCursor : boolean = Object.hasOwn(objRcvd, "moveCursor");
              if (objRcvd.kind === "goal") {
                if (Object.hasOwn(objRcvd, "resetResponses")) {
                  proofState.proofStateMain = [];
                }
                proofState.proofStateResponses = [];
                proofState.proofStateMain.push(this.squirrelAsHTML(objRcvd.payload));
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
                proofState.proofStateResponses.push([objRcvd.kind, this.squirrelAsHTML(objRcvd.payload)]);
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

  public LSPRecvStderr(data : string) : void {
    let objRcvd;
    try {
      objRcvd = JSON.parse(data);
    } catch (e) {
      vscode.window.showWarningMessage(data);
    }
  
    if (Object.hasOwn(objRcvd, "method")) {
      if (objRcvd.method === "pysquirrellsp/lsperror") {
        // If LSP failed to start squirrel, we remove the corresponding `ProofState` from `proofStates`
        if (Object.hasOwn(objRcvd, "failStartup")) {
          const documentId : string = objRcvd.failStartup;
          if (this.proofStates.has(documentId)) {
            this.closeProofClientSide(documentId, true);
          }
        }
        vscode.window.showWarningMessage(`VSquirrel LSP error message: ${objRcvd.data}`);
        if (this.DEBUG_MODE) {
          console.error(`VSquirrel LSP error message: ${objRcvd.data}`);
        }
      } else if (objRcvd.method === "pysquirrellsp/debug") {
        this.logErrorHandle(`VSquirrel LSP debug message: ${objRcvd.data}`);
      } else {
        vscode.window.showErrorMessage(`VSquirrel: LSP server stderr: ${data}`);
        if (this.DEBUG_MODE) {
          console.error(`VSquirrel: LSP server stderr: ${data}`);
        }
      }
    } else {
      vscode.window.showErrorMessage(`VSquirrel: LSP server stderr: ${data}`);
      if (this.DEBUG_MODE) {
        console.error(`VSquirrel: LSP server stderr: ${data}`);
      }
    }
  }

  /** Convert Squirrel's output to text suitable for HTML display */
  private squirrelAsHTML(body : string) : string {
    // Updating default font color to active theme
    if (
          (vscode.window.activeColorTheme.kind === vscode.ColorThemeKind.Light
      || vscode.window.activeColorTheme.kind === vscode.ColorThemeKind.HighContrastLight)
      && (this.foregroundWebviewColor === "#FFF")
    ) {
      this.foregroundWebviewColor = "#000";
      this.ANSItoHTMLConverter = new ConvertANSIToHTML({
        fg: this.foregroundWebviewColor,
        newline: true,
        escapeXML: true
      });
    } else if (
        (vscode.window.activeColorTheme.kind === vscode.ColorThemeKind.Dark
      || vscode.window.activeColorTheme.kind === vscode.ColorThemeKind.HighContrast)
      && (this.foregroundWebviewColor === "#000")
    ) {
      this.foregroundWebviewColor = "#FFF";
      this.ANSItoHTMLConverter = new ConvertANSIToHTML({
        fg: this.foregroundWebviewColor,
        newline: true,
        escapeXML: true
      });
    }
    return this.ANSItoHTMLConverter.toHtml(body);
  }

  private closeProofClientSide(documentId : string, disposeWebviewPanel : boolean) : boolean {
    // `proofState.closing` is used to avoid loop in case closeProof --triggers--> dispose webview --triggers--> closeProof ...
    let proofState = this.proofStates.get(documentId);
    if (proofState === undefined) {
      vscode.window.showErrorMessage("VSquirrel: Proof is not started.");
      return false;
    } else if (!proofState.closing) {
      proofState.closing = true;
      if (disposeWebviewPanel) {
        proofState.proofPanel.dispose();
      }
      // Removing proof state from client
      this.proofStates.delete(documentId);
      // Removing decorations
      proofState.decorationErrorProof.dispose();
      proofState.decorationProcessedProof.dispose();
      proofState.decorationProcessingProof.dispose();
      return true;
    }
    return false;
  }
  
  public closeProof(documentId : string, disposeWebviewPanel : boolean) : void {
    if (this.closeProofClientSide(documentId, disposeWebviewPanel)) {
      // Telling the server to close proof
      this.LSPSend({method:"pysquirrellsp/closeProof", documentId: documentId}, true);
    }
  }
  
  public kill() {
    this.lspProcess.kill();
  }
}