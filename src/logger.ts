import * as vscode from 'vscode';

export type LogLevel = 'INFO' | 'STEP' | 'ERROR';

let outputChannel: vscode.OutputChannel | undefined;

export function initLogger(context: vscode.ExtensionContext): void {
  outputChannel = vscode.window.createOutputChannel('SpringBoot HTTP Helper');
  context.subscriptions.push(outputChannel);
}

export function log(level: LogLevel, message: string): void {
  const now = new Date().toISOString();
  const line = `[${now}] [${level}] ${message}`;
  outputChannel?.appendLine(line);
  if (level === 'ERROR') {
    console.error(line);
    return;
  }
  console.log(line);
}

export function logError(title: string, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  const stack = error instanceof Error && error.stack ? `\n${error.stack}` : '';
  log('ERROR', `${title}: ${message}${stack}`);
}
