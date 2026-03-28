import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { ExercismCli } from './cli/exercismCli';
import { WorkspaceScanner } from './workspace/workspaceScanner';
import { ExercismTreeProvider } from './views/exercismTreeProvider';
import { ExerciseItem } from './views/exerciseItem';
import { ExercisePreviewPanel } from './webview/exercisePreview';
import { Exercise, ExerciseStatus, slugToName } from './models';

export function activate(context: vscode.ExtensionContext): void {
	const outputChannel = vscode.window.createOutputChannel('Exercism');
	context.subscriptions.push(outputChannel);

	const cli = new ExercismCli();
	const scanner = new WorkspaceScanner(() => cli.getConfig());
	const treeProvider = new ExercismTreeProvider(scanner);

	// Register Tree View
	const treeView = vscode.window.createTreeView('exercismExplorer', {
		treeDataProvider: treeProvider,
		showCollapseAll: true,
	});
	context.subscriptions.push(treeView);

	// File watcher for auto-refresh
	const watcher = scanner.createWatcher(() => treeProvider.refresh());
	if (watcher) {
		context.subscriptions.push(watcher);
	}

	// Settings change listener
	context.subscriptions.push(
		vscode.workspace.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration('exercism')) {
				treeProvider.refresh();
			}
		})
	);

	// --- Commands ---

	context.subscriptions.push(
		vscode.commands.registerCommand('exercism.configure', async () => {
			const token = await vscode.window.showInputBox({
				prompt: 'Enter your Exercism API token',
				placeHolder: 'xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx',
				password: true,
				ignoreFocusOut: true,
			});

			if (!token) {
				return;
			}

			try {
				const { installed } = await cli.checkInstalled();
				if (!installed) {
					const action = await vscode.window.showErrorMessage(
						'Exercism CLI is not installed.',
						'Install Instructions'
					);
					if (action) {
						vscode.env.openExternal(vscode.Uri.parse(
							'https://exercism.org/docs/using/solving-exercises/working-locally'
						));
					}
					return;
				}

				await cli.configure(token);

				vscode.window.showInformationMessage('Exercism CLI configured successfully!');
				treeProvider.refresh();
			} catch (err: unknown) {
				const msg = err instanceof Error ? err.message : String(err);
				vscode.window.showErrorMessage(`Failed to configure Exercism CLI: ${msg}`);
			}
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('exercism.download', async () => {
			const { installed } = await cli.checkInstalled();
			if (!installed) {
				showCliNotInstalledError();
				return;
			}

			// Show QuickPick with existing tracks, plus option to type custom
			const scannedTracks = await scanner.scan();
			const trackItems = scannedTracks.map(t => t.slug);
			trackItems.push('$(add) Enter track slug manually...');

			const trackPick = await vscode.window.showQuickPick(trackItems, {
				placeHolder: 'Select a track or enter manually',
			});
			if (!trackPick) {
				return;
			}

			let track: string;
			if (trackPick.startsWith('$(add)')) {
				const input = await vscode.window.showInputBox({
					prompt: 'Enter the track slug (e.g., python, javascript, go)',
					placeHolder: 'python',
				});
				if (!input) { return; }
				track = input;
			} else {
				track = trackPick;
			}

			const exercise = await vscode.window.showInputBox({
				prompt: `Enter the exercise slug for ${track} (e.g., hello-world)`,
				placeHolder: 'hello-world',
			});
			if (!exercise) {
				return;
			}

			await vscode.window.withProgress(
				{
					location: vscode.ProgressLocation.Notification,
					title: `Downloading ${track}/${exercise}...`,
					cancellable: true,
				},
				async (_progress, token) => {
					try {
						const downloadPath = await cli.download(track, exercise, token);
						treeProvider.refresh();

						const action = await vscode.window.showInformationMessage(
							`Downloaded ${track}/${exercise}`,
							'Open Folder',
							'View Instructions'
						);
						if (action === 'Open Folder') {
							const uri = vscode.Uri.file(downloadPath);
							vscode.commands.executeCommand('vscode.openFolder', uri, { forceNewWindow: false });
						} else if (action === 'View Instructions') {
							const ex = buildExerciseFromPath(downloadPath, track, exercise);
							ExercisePreviewPanel.show(ex, context.extensionUri);
						}
					} catch (err: unknown) {
						if (token.isCancellationRequested) {
							return;
						}
						const msg = err instanceof Error ? err.message : String(err);
						vscode.window.showErrorMessage(`Download failed: ${msg}`);
					}
				}
			);
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('exercism.test', async (exerciseArg?: Exercise) => {
			const { installed } = await cli.checkInstalled();
			if (!installed) { showCliNotInstalledError(); return; }

			const exercise = exerciseArg ?? (await detectExercise(scanner));
			if (!exercise) {
				vscode.window.showWarningMessage('No exercise detected. Open an exercise file first.');
				return;
			}

			outputChannel.clear();
			outputChannel.show(true);
			outputChannel.appendLine(`Running tests for ${exercise.track}/${exercise.slug}...\n`);

			await vscode.window.withProgress(
				{
					location: vscode.ProgressLocation.Notification,
					title: `Testing ${exercise.slug}...`,
					cancellable: true,
				},
				async (_progress, token) => {
					const result = await cli.test(exercise.path, token);
					outputChannel.appendLine(result.output);

					if (result.passed) {
						vscode.window.showInformationMessage(`All tests passed for ${exercise.slug}!`);
					} else {
						const action = await vscode.window.showErrorMessage(
							`Tests failed for ${exercise.slug}`,
							'Show Output'
						);
						if (action) {
							outputChannel.show(true);
						}
					}
				}
			);
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('exercism.submit', async (exerciseArg?: Exercise) => {
			const { installed } = await cli.checkInstalled();
			if (!installed) { showCliNotInstalledError(); return; }

			const exercise = exerciseArg ?? (await detectExercise(scanner));
			if (!exercise) {
				vscode.window.showWarningMessage('No exercise detected. Open an exercise file first.');
				return;
			}

			// Find solution files (non-test, non-config files)
			const solutionFiles = findSolutionFiles(exercise.path);
			if (solutionFiles.length === 0) {
				vscode.window.showWarningMessage('No solution files found to submit.');
				return;
			}

			await vscode.window.withProgress(
				{
					location: vscode.ProgressLocation.Notification,
					title: `Submitting ${exercise.slug}...`,
					cancellable: true,
				},
				async (_progress, token) => {
					const result = await cli.submit(solutionFiles, token);
					outputChannel.appendLine(result.output);

					if (result.success) {
						const buttons = result.url ? ['Open in Browser'] : [];
						const action = await vscode.window.showInformationMessage(
							`Solution submitted for ${exercise.slug}!`,
							...buttons
						);
						if (action === 'Open in Browser' && result.url) {
							vscode.env.openExternal(vscode.Uri.parse(result.url));
						}
						treeProvider.refresh();
					} else {
						vscode.window.showErrorMessage(`Submit failed: ${result.output}`);
					}
				}
			);
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('exercism.openInstructions', async (exerciseArg?: Exercise) => {
			const exercise = exerciseArg ?? (await detectExercise(scanner));
			if (!exercise) {
				vscode.window.showWarningMessage('No exercise detected. Open an exercise file first.');
				return;
			}
			ExercisePreviewPanel.show(exercise, context.extensionUri);
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('exercism.openInBrowser', async (exerciseArg?: Exercise) => {
			const exercise = exerciseArg ?? (await detectExercise(scanner));
			if (!exercise) {
				vscode.window.showWarningMessage('No exercise detected. Open an exercise file first.');
				return;
			}
			const url = `https://exercism.org/tracks/${exercise.track}/exercises/${exercise.slug}`;
			vscode.env.openExternal(vscode.Uri.parse(url));
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('exercism.refreshTree', () => {
			treeProvider.refresh();
		})
	);

	outputChannel.appendLine('Exercism Helper extension activated');
}

export function deactivate(): void {
	// Cleanup handled by disposables
}

// --- Helper functions ---

function showCliNotInstalledError(): void {
	vscode.window.showErrorMessage(
		'Exercism CLI is not installed.',
		'Install Instructions'
	).then(action => {
		if (action) {
			vscode.env.openExternal(vscode.Uri.parse(
				'https://exercism.org/docs/using/solving-exercises/working-locally'
			));
		}
	});
}

async function detectExercise(scanner: WorkspaceScanner): Promise<Exercise | undefined> {
	const editor = vscode.window.activeTextEditor;
	if (!editor) {
		return undefined;
	}

	const filePath = editor.document.uri.fsPath;

	// Walk up from file to find .exercism/metadata.json
	let dir = path.dirname(filePath);
	while (dir !== path.dirname(dir)) {
		const metadataPath = path.join(dir, '.exercism', 'metadata.json');
		if (fs.existsSync(metadataPath)) {
			const exerciseSlug = path.basename(dir);
			const trackSlug = path.basename(path.dirname(dir));
			return buildExerciseFromPath(dir, trackSlug, exerciseSlug);
		}
		dir = path.dirname(dir);
	}

	return undefined;
}

function buildExerciseFromPath(exercisePath: string, track: string, slug: string): Exercise {
	return {
		slug,
		name: slugToName(slug),
		track,
		path: exercisePath,
		status: ExerciseStatus.Downloaded,
		hasReadme: fs.existsSync(path.join(exercisePath, 'README.md')),
		hasHints: fs.existsSync(path.join(exercisePath, 'HINTS.md')),
		hasHelp: fs.existsSync(path.join(exercisePath, 'HELP.md')),
	};
}

function findSolutionFiles(exercisePath: string): string[] {
	// Read .exercism/config.json to find solution files if available
	const configPath = path.join(exercisePath, '.exercism', 'config.json');
	if (fs.existsSync(configPath)) {
		try {
			const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
			if (config.files?.solution) {
				return (config.files.solution as string[])
					.map(f => path.join(exercisePath, f))
					.filter(f => fs.existsSync(f));
			}
		} catch {
			// Fall through to heuristic
		}
	}

	// Fallback: return all non-hidden, non-test files
	try {
		const entries = fs.readdirSync(exercisePath, { withFileTypes: true });
		return entries
			.filter(e => e.isFile() && !e.name.startsWith('.') && !e.name.includes('test'))
			.map(e => path.join(exercisePath, e.name));
	} catch {
		return [];
	}
}
