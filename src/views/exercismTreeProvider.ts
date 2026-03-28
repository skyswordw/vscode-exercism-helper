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

    // Build a quick lookup: trackSlug -> { exerciseSlug -> ScannedExercise }
    const localMap = new Map<string, Map<string, ScannedExercise>>();
    for (const st of scannedTracks) {
      const exMap = new Map<string, ScannedExercise>();
      for (const se of st.exercises) {
        exMap.set(se.slug, se);
      }
      localMap.set(st.slug, exMap);
    }

    // 2. Try to get API token for authenticated calls
    let token = '';
    try {
      const config = await this.cli.getConfig();
      token = config.token;
    } catch {
      // offline or CLI not configured — fall back to local-only
    }

    // 3. For each locally-known track, fetch API data and merge
    const tracks: Track[] = [];

    for (const scanned of scannedTracks) {
      // Fetch full exercise list from API (unauthenticated)
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
        apiExercises = await this.cli.fetchExercises(scanned.slug, token || undefined);
      } catch {
        // offline — use local exercises only
      }

      // Fetch user solutions (authenticated)
      let solutionMap = new Map<string, string>();
      if (token) {
        try {
          solutionMap = await this.cli.fetchUserSolutions(scanned.slug, token);
        } catch {
          // ignore — proceed without solution status
        }
      }

      const localExMap = localMap.get(scanned.slug) ?? new Map<string, ScannedExercise>();

      let exercises: Exercise[];

      if (apiExercises.length > 0) {
        // Merge API list with local files and solution statuses
        exercises = apiExercises.map((apiEx, index) => {
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
            // Downloaded locally but no API solution status → treat as Started
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
            track: scanned.slug,
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
      } else {
        // Fallback: only local exercises
        exercises = scanned.exercises.map(se => this.toExercise(se, solutionMap));
      }

      tracks.push({
        slug: scanned.slug,
        name: slugToName(scanned.slug),
        path: scanned.path,
        exercises,
        totalExercises: apiExercises.length > 0 ? apiExercises.length : undefined,
      });
    }

    return tracks;
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
