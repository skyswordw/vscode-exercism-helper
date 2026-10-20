import * as vscode from 'vscode';
import { ExercismCli, isTrackNotJoinedError } from '../cli/exercismCli';

export async function promptJoinAndDownload(
	cli: ExercismCli,
	onDownloaded: () => void,
	track: string,
	exercise: string,
	onSuccess: (downloadPath: string) => Promise<void> | void
): Promise<void> {
	const choice = await vscode.window.showWarningMessage(
		`You have not joined the ${track} track yet on Exercism. Would you like to join it now to download "${exercise}"?`,
		'Join Track on Exercism',
		'Cancel'
	);
	if (choice !== 'Join Track on Exercism') {
		return;
	}

	// 1. Open the track page in the user's browser
	const trackUrl = `https://exercism.org/tracks/${encodeURIComponent(track)}`;
	await vscode.env.openExternal(vscode.Uri.parse(trackUrl));

	// 2. Fetch CLI token if available to enable auto-detection
	let token = '';
	try {
		const config = await cli.getConfig();
		token = config.token;
	} catch { /* no token */ }

	// 3. Show progress and poll for the track to be joined
	let downloadPath = '';
	let downloadError = '';
	let userCancelled = false;

	await vscode.window.withProgress(
		{
			location: vscode.ProgressLocation.Notification,
			title: `Waiting for ${track} track to be joined...`,
			cancellable: true,
		},
		async (progress, cancellationToken) => {
			try {
				progress.report({ message: 'Click "Join this track" in your browser...' });
				const deadline = Date.now() + 60000;

				while (token && !cancellationToken.isCancellationRequested && Date.now() < deadline) {
					await waitForNextPoll(Math.min(2500, deadline - Date.now()), cancellationToken);
					const remainingMs = deadline - Date.now();
					if (cancellationToken.isCancellationRequested || remainingMs <= 0) { return; }

					const isJoined = await cli.isTrackJoined(track, token, {
						cancellationToken,
						timeoutMs: remainingMs,
					});
					if (cancellationToken.isCancellationRequested || Date.now() >= deadline) { return; }
					if (isJoined) {
						progress.report({ message: `Track joined! Downloading ${track}/${exercise}...` });
						try {
							downloadPath = await cli.download(track, exercise, cancellationToken);
							cli.clearCache();
							onDownloaded();
						} catch (err: unknown) {
							downloadError = err instanceof Error ? err.message : String(err);
						}
						return;
					}
				}
			} finally {
				userCancelled = cancellationToken.isCancellationRequested;
			}
		}
	);

	if (userCancelled) {
		return;
	}

	if (downloadPath) {
		await onSuccess(downloadPath);
		return;
	}

	// If auto-detection timed out or errored, offer a manual "Download Now" retry
	const retryAction = await vscode.window.showInformationMessage(
		`Once you've joined the ${track} track on Exercism, click "Download Now" to proceed.`,
		'Download Now',
		'Open Track Again',
		'Cancel'
	);

	if (retryAction === 'Download Now') {
		downloadError = '';
		await vscode.window.withProgress(
			{
				location: vscode.ProgressLocation.Notification,
				title: `Downloading ${track}/${exercise}...`,
				cancellable: true,
			},
			async (_progress, cancellationToken) => {
				try {
					downloadPath = await cli.download(track, exercise, cancellationToken);
					cli.clearCache();
					onDownloaded();
				} catch (err: unknown) {
					downloadError = err instanceof Error ? err.message : String(err);
				} finally {
					userCancelled = cancellationToken.isCancellationRequested;
				}
			}
		);

		if (userCancelled) { return; }
		if (downloadPath) {
			await onSuccess(downloadPath);
		} else if (downloadError) {
			if (isTrackNotJoinedError(downloadError)) {
				vscode.window.showErrorMessage(
					`The ${track} track still hasn't been joined. Please ensure you are logged into exercism.org and clicked "Join this track".`
				);
			} else {
				vscode.window.showErrorMessage(`Download failed: ${downloadError}`);
			}
		}
	} else if (retryAction === 'Open Track Again') {
		await promptJoinAndDownload(cli, onDownloaded, track, exercise, onSuccess);
	}
}

function waitForNextPoll(ms: number, token: vscode.CancellationToken): Promise<void> {
	return new Promise(resolve => {
		let cancellation: vscode.Disposable | undefined;
		const done = () => {
			clearTimeout(timer);
			cancellation?.dispose();
			resolve();
		};
		const timer = setTimeout(done, ms);
		cancellation = token.onCancellationRequested(done);
		if (token.isCancellationRequested) { done(); }
	});
}
