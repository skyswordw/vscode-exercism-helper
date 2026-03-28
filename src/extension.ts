import * as vscode from 'vscode';

export function activate(context: vscode.ExtensionContext): void {
	// TODO: Register commands, views, and providers
	const outputChannel = vscode.window.createOutputChannel('Exercism');
	context.subscriptions.push(outputChannel);

	outputChannel.appendLine('Exercism Helper extension activated');
}

export function deactivate(): void {
	// Cleanup
}
