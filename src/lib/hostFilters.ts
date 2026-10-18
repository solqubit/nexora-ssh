import type { AppSnapshot, Host } from "../types";
export const filterKey = (value: string) => value.trim().toLocaleLowerCase();
export function hostEnvironment(snapshot: AppSnapshot, hostId: string): string {
  return snapshot.productivity?.connectionProfiles?.find(profile => profile.hostId === hostId)?.environment?.trim() ?? "";
}
export function uniqueLabels(values: string[]): string[] {
  const labels = new Map<string, string>();
  for (const value of values) { const trimmed = value.trim(); if (trimmed && !labels.has(filterKey(trimmed))) labels.set(filterKey(trimmed), trimmed); }
  return [...labels.values()].sort((a, b) => a.localeCompare(b));
}
export function matchesHostLabels(host: Host, environment: string, selectedEnvironment: string | null, selectedTags: string[]) {
  const tags = new Set(host.tags.map(filterKey));
  return (selectedEnvironment === null || filterKey(environment) === filterKey(selectedEnvironment)) && selectedTags.every(tag => tags.has(filterKey(tag)));
}
