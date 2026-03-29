import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { WorkspaceScanner, ScannedTrack, ScannedExercise } from '../workspace/workspaceScanner';
import { Track, Exercise, ExerciseStatus, slugToName } from '../models';
import { ExercismCli } from '../cli/exercismCli';
import { TrackItem } from './trackItem';
import { ExerciseItem } from './exerciseItem';

type TreeNode = TrackItem | ExerciseItem;

export class ExercismTreeProvider implements vscode.TreeDataProvider<TreeNode> {
  private _onDidChangeTreeData = new vscode.EventEmitter<TreeNode | undefined | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private tracks: Track[] = [];
  private _sortOrder: 'default' | 'reverse' | 'easy-first' | 'hard-first' = 'default';
  private _collapsed = false;
  private _token = '';
  private _localMap = new Map<string, Map<string, ScannedExercise>>();

  constructor(
    private readonly scanner: WorkspaceScanner,
    private readonly cli: ExercismCli,
  ) {}

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  toggleSort(): void {
    const cycle: Array<typeof this._sortOrder> = ['default', 'reverse', 'easy-first', 'hard-first'];
    const idx = cycle.indexOf(this._sortOrder);
    this._sortOrder = cycle[(idx + 1) % cycle.length];
    this._onDidChangeTreeData.fire();
  }

  get sortOrder(): string { return this._sortOrder; }

  getTracks(): Track[] { return this.tracks; }

  get isCollapsed(): boolean { return this._collapsed; }

  toggleCollapse(): void {
    this._collapsed = !this._collapsed;
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: TreeNode): vscode.TreeItem {
    return element;
  }

  getParent(element: TreeNode): TreeNode | undefined {
    if (element instanceof ExerciseItem) {
      const track = this.tracks.find(t => t.slug === element.exercise.track);
      return track ? new TrackItem(track, this._collapsed) : undefined;
    }
    return undefined;
  }

  async getChildren(element?: TreeNode): Promise<TreeNode[]> {
    if (!element) {
      this.tracks = await this.loadTracks();
      return this.tracks.map(t => new TrackItem(t, this._collapsed));
    }

    if (element instanceof TrackItem) {
      // Lazy load: fetch exercises when track is expanded
      if (element.track.exercises.length === 0) {
        const exercises = await this.loadExercisesForTrack(element.track.slug);
        element.track.exercises = exercises;
        // Update cached track
        const cached = this.tracks.find(t => t.slug === element.track.slug);
        if (cached) { cached.exercises = exercises; }
      }

      const difficultyOrder: Record<string, number> = { easy: 1, medium: 2, hard: 3 };
      let exercises = [...element.track.exercises];
      switch (this._sortOrder) {
        case 'reverse':
          exercises.sort((a, b) => (b.order ?? 999) - (a.order ?? 999));
          break;
        case 'easy-first':
          exercises.sort((a, b) => (difficultyOrder[a.difficulty ?? ''] ?? 2) - (difficultyOrder[b.difficulty ?? ''] ?? 2));
          break;
        case 'hard-first':
          exercises.sort((a, b) => (difficultyOrder[b.difficulty ?? ''] ?? 2) - (difficultyOrder[a.difficulty ?? ''] ?? 2));
          break;
        // 'default': keep API order (already sorted by order)
      }
      return exercises.map(e => new ExerciseItem(e));
    }

    return [];
  }

  private async loadTracks(): Promise<Track[]> {
    // 1. Scan local workspace for downloaded exercises
    const scannedTracks = await this.scanner.scan();

    // Build local lookup and cache it for lazy exercise loading
    this._localMap = new Map<string, Map<string, ScannedExercise>>();
    for (const st of scannedTracks) {
      const exMap = new Map<string, ScannedExercise>();
      for (const se of st.exercises) {
        exMap.set(se.slug, se);
      }
      this._localMap.set(st.slug, exMap);
    }

    // 2. Try to get API token
    this._token = '';
    try {
      const config = await this.cli.getConfig();
      this._token = config.token;
    } catch {
      // offline or CLI not configured
    }

    // 3. Only show tracks that have local exercises
    //    Users add new tracks via the Download command
    const tracks: Track[] = [];

    for (const scanned of scannedTracks) {
      // Try to get total exercise count from API for display
      let totalExercises: number | undefined;
      try {
        const apiTracks = await this.cli.fetchTracks();
        const apiTrack = apiTracks.find(t => t.slug === scanned.slug);
        if (apiTrack) {
          totalExercises = apiTrack.numExercises;
        }
      } catch { /* offline */ }

      tracks.push({
        slug: scanned.slug,
        name: slugToName(scanned.slug),
        path: scanned.path,
        exercises: [], // lazy loaded on expand
        totalExercises,
      });
    }

    return tracks;
  }

  private async loadExercisesForTrack(trackSlug: string): Promise<Exercise[]> {
    const localExMap = this._localMap.get(trackSlug) ?? new Map<string, ScannedExercise>();

    let apiExercises: Array<{
      slug: string;
      title: string;
      difficulty: string;
      isUnlocked: boolean;
      isRecommended: boolean;
      type: string;
      blurb: string;
    }> = [];
    try {
      apiExercises = await this.cli.fetchExercises(trackSlug, this._token || undefined);
    } catch {
      // offline
    }

    let solutionMap = new Map<string, string>();
    if (this._token) {
      try {
        solutionMap = await this.cli.fetchUserSolutions(trackSlug, this._token);
      } catch { /* ignore */ }
    }

    if (apiExercises.length > 0) {
      return apiExercises.map((apiEx, index) => {
        const localEx = localExMap.get(apiEx.slug);
        const solutionStatus = solutionMap.get(apiEx.slug);

        let status: ExerciseStatus;
        if (solutionStatus === 'published') {
          status = ExerciseStatus.Published;
        } else if (solutionStatus === 'completed') {
          status = ExerciseStatus.Completed;
        } else if (solutionStatus === 'started' || solutionStatus === 'iterated') {
          status = ExerciseStatus.Started;
        } else if (localEx) {
          status = ExerciseStatus.Started;
        } else if (apiEx.isUnlocked) {
          status = ExerciseStatus.Available;
        } else {
          status = ExerciseStatus.Locked;
        }

        const exercisePath = localEx ? localEx.path : '';
        const hasHelp = localEx ? fs.existsSync(path.join(localEx.path, 'HELP.md')) : false;

        return {
          slug: apiEx.slug,
          name: apiEx.title || slugToName(apiEx.slug),
          track: trackSlug,
          path: exercisePath,
          status,
          hasReadme: localEx ? localEx.hasReadme : false,
          hasHints: localEx ? localEx.hasHints : false,
          hasHelp,
          isRecommended: apiEx.isRecommended,
          isDownloaded: !!localEx,
          difficulty: apiEx.difficulty,
          order: index,
        };
      });
    }

    // Fallback: local exercises only
    const scannedExercises = [...localExMap.values()];
    return scannedExercises.map(se => this.toExercise(se, solutionMap));
  }

  private toExercise(scanned: ScannedExercise, solutionMap: Map<string, string>): Exercise {
    const hasHelp = fs.existsSync(path.join(scanned.path, 'HELP.md'));
    const solutionStatus = solutionMap.get(scanned.slug);

    let status: ExerciseStatus;
    if (solutionStatus === 'published') {
      status = ExerciseStatus.Published;
    } else if (solutionStatus === 'completed') {
      status = ExerciseStatus.Completed;
    } else if (solutionStatus === 'started' || solutionStatus === 'iterated') {
      status = ExerciseStatus.Started;
    } else {
      status = scanned.status; // Downloaded
    }

    return {
      slug: scanned.slug,
      name: slugToName(scanned.slug),
      track: scanned.track,
      path: scanned.path,
      status,
      hasReadme: scanned.hasReadme,
      hasHints: scanned.hasHints,
      hasHelp,
      isRecommended: false,
      isDownloaded: true,
    };
  }
}
