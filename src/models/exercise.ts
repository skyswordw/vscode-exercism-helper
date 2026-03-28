export enum ExerciseStatus {
  Published = 'published',      // completed and published
  Completed = 'completed',      // completed but not published
  Started = 'started',          // started but not completed
  Available = 'available',      // unlocked but not started
  Locked = 'locked',            // not yet unlocked
  // Legacy value retained for local-scan fallback
  Downloaded = 'downloaded',
}

export interface Exercise {
  slug: string;           // e.g., "hello-world"
  name: string;           // Display name, e.g., "Hello World" (derived from slug)
  track: string;          // Parent track slug, e.g., "python"
  path: string;           // Absolute path to exercise directory (empty string if not downloaded)
  status: ExerciseStatus;
  hasReadme: boolean;
  hasHints: boolean;
  hasHelp: boolean;
  isRecommended?: boolean; // true if Exercism marks it as the next recommended exercise
  isDownloaded?: boolean;  // true if the exercise exists locally
  difficulty?: string;     // "easy", "medium", or "hard" from API
  order?: number;          // Position in the official learning path (0-based index from API)
}

// Convert slug to display name: "hello-world" -> "Hello World"
export function slugToName(slug: string): string {
  return slug
    .split('-')
    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}
