import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { ExercismCli } from './cli/exercismCli';
import { WorkspaceScanner } from './workspace/workspaceScanner';
import { ExercismTreeProvider } from './views/exercismTreeProvider';
import { ExerciseItem } from './views/exerciseItem';
import { ExercisePreviewPanel } from './webview/exercisePreview';
import { Exercise, ExerciseStatus, slugToName } from './models';

// Debug file logger
const LOG_FILE = path.join(__dirname, '..', 'exercism-debug.log');
function log(msg: string): void {
	const timestamp = new Date().toISOString();
	const line = `[${timestamp}] ${msg}\n`;
	try { fs.appendFileSync(LOG_FILE, line); } catch { /* ignore */ }
}

export function activate(context: vscode.ExtensionContext): void {
	// Clear previous log
	try { fs.writeFileSync(LOG_FILE, ''); } catch { /* ignore */ }
	log('=== Exercism Helper activating ===');

	const outputChannel = vscode.window.createOutputChannel('Exercism');
	context.subscriptions.push(outputChannel);

	const cli = new ExercismCli();
	const scanner = new WorkspaceScanner(() => cli.getConfig());

	// Set context for welcome view conditional display
	async function updateConfiguredContext() {
		let configured = false;
		try {
			const config = await cli.getConfig();
			configured = !!config.token;
		} catch { /* not configured */ }
		vscode.commands.executeCommand('setContext', 'exercism.configured', configured);
		log(`Context exercism.configured = ${configured}`);
	}
	updateConfiguredContext();

	// Log startup diagnostics
	cli.checkInstalled().then(result => {
		log(`CLI check: installed=${result.installed}, version=${result.version ?? 'N/A'}`);
	}).catch(err => {
		log(`CLI check error: ${err}`);
	});
	scanner.getWorkspacePath().then(wp => {
		log(`Workspace path resolved: ${wp ?? 'NONE'}`);
	}).catch(err => {
		log(`Workspace path error: ${err}`);
	});
	scanner.scan().then(tracks => {
		log(`Scan result: ${tracks.length} tracks found`);
		for (const t of tracks) {
			log(`  Track: ${t.slug} (${t.exercises.length} exercises)`);
			for (const e of t.exercises) {
				log(`    Exercise: ${e.slug} [readme=${e.hasReadme}, hints=${e.hasHints}]`);
			}
		}
	}).catch(err => {
		log(`Scan error: ${err}`);
	});
	const treeProvider = new ExercismTreeProvider(scanner, cli);

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
			log('Command: exercism.configure triggered');
			// Step 1: Check CLI is installed
			const { installed } = await cli.checkInstalled();
			log(`CLI installed: ${installed}`);
			if (!installed) {
				const action = await vscode.window.showErrorMessage(
					'Exercism CLI is not installed. Please install it first.',
					'Install CLI',
					'How to Install'
				);
				if (action === 'Install CLI' || action === 'How to Install') {
					vscode.env.openExternal(vscode.Uri.parse(
						'https://exercism.org/docs/using/solving-exercises/working-locally'
					));
				}
				return;
			}

			// Step 2: Check if already configured
			let existingToken = '';
			try {
				const config = await cli.getConfig();
				existingToken = config.token;
			} catch { /* not configured */ }

			if (existingToken) {
				const masked = '****' + existingToken.slice(-4);
				const action = await vscode.window.showInformationMessage(
					`Exercism is already configured (token: ${masked}).`,
					'Reconfigure',
					'Cancel'
				);
				if (action !== 'Reconfigure') {
					return;
				}
			}

			// Step 3: Guide user to get API token
			const action = await vscode.window.showInformationMessage(
				'To configure Exercism, you need your API token from exercism.org.',
				'Get API Token',
				'I Have a Token'
			);

			if (!action) {
				return;
			}

			if (action === 'Get API Token') {
				vscode.env.openExternal(vscode.Uri.parse('https://exercism.org/settings/api_cli'));
			}

			const token = await vscode.window.showInputBox({
				prompt: action === 'Get API Token'
					? 'Paste your API token from exercism.org/settings/api_cli'
					: 'Enter your Exercism API token',
				placeHolder: 'xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx',
				password: true,
				ignoreFocusOut: true,
			});
			if (!token) { return; }

			await vscode.window.withProgress(
				{
					location: vscode.ProgressLocation.Notification,
					title: 'Configuring Exercism...',
				},
				async () => {
					try {
						await cli.configure(token);
						cli.clearCache();
						await updateConfiguredContext();
						vscode.window.showInformationMessage('Exercism configured successfully! Use "Download Exercise" to get started.');
						treeProvider.refresh();
					} catch (err: unknown) {
						const msg = err instanceof Error ? err.message : String(err);
						vscode.window.showErrorMessage(`Failed to configure: ${msg}`);
					}
				}
			);
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('exercism.download', async () => {
			log('Command: exercism.download triggered');
			const { installed } = await cli.checkInstalled();
			if (!installed) {
				showCliNotInstalledError();
				return;
			}

			// Step 1: Fetch and show track list from Exercism API
			let trackItems: vscode.QuickPickItem[];
			try {
				const tracks = await cli.fetchTracks();
				trackItems = tracks.map(t => ({
					label: t.title,
					description: `${t.numExercises} exercises`,
					detail: t.slug,
				}));
			} catch {
				// Fallback to local tracks if API fails
				const scannedTracks = await scanner.scan();
				trackItems = scannedTracks.map(t => ({
					label: t.slug,
					description: `${t.exercises.length} exercises (local)`,
					detail: t.slug,
				}));
			}
			log(`Fetched ${trackItems.length} tracks for download picker`);

			const trackPick = await vscode.window.showQuickPick(trackItems, {
				placeHolder: 'Select a language track',
				matchOnDescription: true,
				matchOnDetail: true,
			});
			if (!trackPick) { return; }
			const track = trackPick.detail!;

			// Step 2: Fetch and show exercise list for selected track
			let exerciseItems: vscode.QuickPickItem[];
			try {
				let token = '';
				try {
					const config = await cli.getConfig();
					token = config.token;
				} catch { /* no token */ }

				const exercises = await cli.fetchExercises(track, token || undefined);
				// Get local + solution data for status icons
				const scannedTracks = await scanner.scan();
				const localTrack = scannedTracks.find(t => t.slug === track);
				const localSlugs = new Set(localTrack?.exercises.map(e => e.slug) ?? []);

				let solutionMap = new Map<string, string>();
				if (token) {
					try { solutionMap = await cli.fetchUserSolutions(track, token); } catch { /* ignore */ }
				}

				// Sort: recommended first, then rest in original order
				const sorted = [...exercises].sort((a, b) => {
					if (a.isRecommended && !b.isRecommended) { return -1; }
					if (!a.isRecommended && b.isRecommended) { return 1; }
					return 0;
				});

				exerciseItems = sorted.map(e => {
					const solutionStatus = solutionMap.get(e.slug);
					const isLocal = localSlugs.has(e.slug);

					// Match tree view icons
					let icon: string;
					if (e.isRecommended) {
						icon = '$(star-full)';
					} else if (solutionStatus === 'published' || solutionStatus === 'completed') {
						icon = '$(check)';
					} else if (solutionStatus === 'started' || solutionStatus === 'iterated' || isLocal) {
						icon = '$(tools)';
					} else if (e.isUnlocked) {
						icon = '$(circle-outline)';
					} else {
						icon = '$(lock)';
					}

					return {
						label: `${icon} ${e.title}`,
						description: [
							e.difficulty,
							e.isRecommended ? 'recommended' : '',
							isLocal ? 'downloaded' : '',
						].filter(Boolean).join(' · '),
						detail: e.slug,
					};
				});
			} catch {
				// Fallback to manual input
				const input = await vscode.window.showInputBox({
					prompt: `Enter the exercise slug for ${track}`,
					placeHolder: 'hello-world',
				});
				if (!input) { return; }
				exerciseItems = [{ label: input, detail: input }];
			}
			log(`Fetched ${exerciseItems.length} exercises for track ${track}`);

			const exercisePick = await vscode.window.showQuickPick(exerciseItems, {
				placeHolder: `Select an exercise from ${trackPick.label}`,
				matchOnDescription: true,
				matchOnDetail: true,
			});
			if (!exercisePick) { return; }
			const exercise = exercisePick.detail!;

			let downloadPath = '';
			let downloadError = '';
			let cancelled = false;

			await vscode.window.withProgress(
				{
					location: vscode.ProgressLocation.Notification,
					title: `Downloading ${track}/${exercise}...`,
					cancellable: true,
				},
				async (_progress, token) => {
					try {
						downloadPath = await cli.download(track, exercise, token);
						cli.clearCache();
						treeProvider.refresh();
					} catch (err: unknown) {
						if (token.isCancellationRequested) {
							cancelled = true;
							return;
						}
						downloadError = err instanceof Error ? err.message : String(err);
					}
				}
			);

			if (cancelled) { return; }
			if (downloadError) {
				vscode.window.showErrorMessage(`Download failed: ${downloadError}`);
				return;
			}

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
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('exercism.test', async (arg?: Exercise | ExerciseItem) => {
			// Context menu passes ExerciseItem, command palette passes Exercise
			const exerciseArg = arg instanceof ExerciseItem ? arg.exercise : arg;
			log(`Command: exercism.test triggered, arg=${exerciseArg?.slug ?? 'none'}`);
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
		vscode.commands.registerCommand('exercism.submit', async (arg?: Exercise | ExerciseItem) => {
			const exerciseArg = arg instanceof ExerciseItem ? arg.exercise : arg;
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
						cli.clearCache(); // Clear cache so refresh fetches latest status
						treeProvider.refresh();
					} else {
						vscode.window.showErrorMessage(`Submit failed: ${result.output}`);
					}
				}
			);
		})
	);

	// Download a specific exercise (from tree view click or inline button)
	context.subscriptions.push(
		vscode.commands.registerCommand('exercism.downloadExercise', async (arg?: Exercise | ExerciseItem) => {
			const exerciseArg = arg instanceof ExerciseItem ? arg.exercise : arg;
			if (!exerciseArg) { return; }
			log(`Command: exercism.downloadExercise triggered for ${exerciseArg.track}/${exerciseArg.slug}`);

			await vscode.window.withProgress(
				{
					location: vscode.ProgressLocation.Notification,
					title: `Downloading ${exerciseArg.track}/${exerciseArg.slug}...`,
					cancellable: true,
				},
				async (_progress, token) => {
					try {
						const downloadPath = await cli.download(exerciseArg.track, exerciseArg.slug, token);
						cli.clearCache();
						treeProvider.refresh();

						const action = await vscode.window.showInformationMessage(
							`Downloaded ${exerciseArg.slug}`,
							'Open Exercise'
						);
						if (action === 'Open Exercise') {
							const ex = buildExerciseFromPath(downloadPath, exerciseArg.track, exerciseArg.slug);
							// Open solution file + instructions
							const solutionFiles = findSolutionFiles(downloadPath);
							if (solutionFiles.length > 0) {
								const doc = await vscode.workspace.openTextDocument(solutionFiles[0]);
								await vscode.window.showTextDocument(doc, vscode.ViewColumn.One);
							}
							ExercisePreviewPanel.show(ex, context.extensionUri);
						}
					} catch (err: unknown) {
						if (token.isCancellationRequested) { return; }
						const msg = err instanceof Error ? err.message : String(err);
						vscode.window.showErrorMessage(`Download failed: ${msg}`);
					}
				}
			);
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('exercism.openInstructions', async (arg?: Exercise | ExerciseItem) => {
			const exerciseArg = arg instanceof ExerciseItem ? arg.exercise : arg;
			log(`Command: exercism.openInstructions triggered, arg=${JSON.stringify(exerciseArg?.slug ?? 'none')}`);
			const exercise = exerciseArg ?? (await detectExercise(scanner));
			if (!exercise) {
				vscode.window.showWarningMessage('No exercise detected. Open an exercise file first.');
				return;
			}

			const readerPosition = vscode.workspace.getConfiguration('exercism').get<string>('readerPosition', 'left');
			// If reader is on left (ViewColumn.One), editor opens in ViewColumn.Two
			// If reader is on right (ViewColumn.Beside), editor opens in ViewColumn.One
			const editorColumn = readerPosition === 'left' ? vscode.ViewColumn.Two : vscode.ViewColumn.One;

			// Open the main solution file in the editor
			const solutionFiles = findSolutionFiles(exercise.path);
			if (solutionFiles.length > 0) {
				const mainFile = solutionFiles[0];
				log(`Opening solution file: ${mainFile}`);
				const doc = await vscode.workspace.openTextDocument(mainFile);
				await vscode.window.showTextDocument(doc, editorColumn);
			}

			// Open instructions webview (position determined by readerPosition setting)
			ExercisePreviewPanel.show(exercise, context.extensionUri);
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('exercism.toggleLayout', async () => {
			const config = vscode.workspace.getConfiguration('exercism');
			const current = config.get<string>('readerPosition', 'left');
			const newValue = current === 'left' ? 'right' : 'left';
			await config.update('readerPosition', newValue, vscode.ConfigurationTarget.Global);

			// Collect state before closing anything
			const currentExercise = ExercisePreviewPanel.getCurrentExercise();
			// Collect all open text editor file URIs (not webview)
			const openFileUris = vscode.window.tabGroups.all
				.flatMap(g => g.tabs)
				.filter(tab => tab.input instanceof vscode.TabInputText)
				.map(tab => (tab.input as vscode.TabInputText).uri);

			if (currentExercise) {
				// Close everything
				ExercisePreviewPanel.dispose();
				await vscode.commands.executeCommand('workbench.action.closeAllEditors');

				if (newValue === 'left') {
					// Reader left (Column 1), code right (Column 2)
					ExercisePreviewPanel.show(currentExercise, context.extensionUri);
					for (const uri of openFileUris) {
						const doc = await vscode.workspace.openTextDocument(uri);
						await vscode.window.showTextDocument(doc, vscode.ViewColumn.Two, true);
					}
				} else {
					// Code left (Column 1), reader right (Column 2)
					for (const uri of openFileUris) {
						const doc = await vscode.workspace.openTextDocument(uri);
						await vscode.window.showTextDocument(doc, vscode.ViewColumn.One, true);
					}
					ExercisePreviewPanel.show(currentExercise, context.extensionUri);
				}
			}

			vscode.window.showInformationMessage(`Layout: ${newValue === 'left' ? 'Reader | Code' : 'Code | Reader'}`);
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('exercism.openInBrowser', async (arg?: Exercise | ExerciseItem) => {
			const exerciseArg = arg instanceof ExerciseItem ? arg.exercise : arg;
			const exercise = exerciseArg ?? (await detectExercise(scanner));
			if (!exercise) {
				vscode.window.showWarningMessage('No exercise detected. Open an exercise file first.');
				return;
			}
			// Try to read URL from .exercism/metadata.json first
			let url = `https://exercism.org/tracks/${exercise.track}/exercises/${exercise.slug}`;
			try {
				const metadataPath = path.join(exercise.path, '.exercism', 'metadata.json');
				if (fs.existsSync(metadataPath)) {
					const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
					if (metadata.url) {
						url = metadata.url;
					}
				}
			} catch { /* use fallback URL */ }
			log(`Opening in browser: ${url}`);
			vscode.env.openExternal(vscode.Uri.parse(url));
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('exercism.refreshTree', () => {
			cli.clearCache();
			treeProvider.refresh();
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('exercism.toggleSort', () => {
			treeProvider.toggleSort();
			const order = treeProvider.sortOrder;
			const labels: Record<string, string> = {
				'default': 'Learning Path (official order)',
				'reverse': 'Learning Path (reversed)',
				'easy-first': 'Easy → Hard',
				'hard-first': 'Hard → Easy',
			};
			vscode.window.showInformationMessage(`Sort: ${labels[order]}`);
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('exercism.expandAll', () => {
			treeProvider.toggleCollapse();
		})
	);

	outputChannel.appendLine('Exercism Helper extension activated');
	log('=== Exercism Helper activated successfully ===');
	log(`Extension URI: ${context.extensionUri.fsPath}`);
	log(`Log file: ${LOG_FILE}`);
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
		isDownloaded: true,
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
