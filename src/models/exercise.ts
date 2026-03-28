export enum ExerciseStatus {
  Downloaded = 'downloaded',
  NotDownloaded = 'not_downloaded'
}

export interface Exercise {
  slug: string;           // e.g., "hello-world"
  name: string;           // Display name, e.g., "Hello World" (derived from slug)
  track: string;          // Parent track slug, e.g., "python"
  path: string;           // Absolute path to exercise directory
  status: ExerciseStatus;
  hasReadme: boolean;
  hasHints: boolean;
  hasHelp: boolean;
}

// Convert slug to display name: "hello-world" -> "Hello World"
export function slugToName(slug: string): string {
  return slug
    .split('-')
    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}
