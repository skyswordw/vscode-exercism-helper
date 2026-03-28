import { Exercise } from './exercise';

export interface Track {
  slug: string;           // e.g., "python"
  name: string;           // Display name, e.g., "Python" (derived from slug)
  path: string;           // Absolute path to track directory
  exercises: Exercise[];
}
