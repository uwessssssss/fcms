/** A shift's label as people say it. Kiboga runs DAY, MID and NIGHT (570). */
export function shiftLabelName(label: string): string {
  switch ((label || '').toUpperCase()) {
    case 'DAY': return 'Day';
    case 'MID': return 'Mid';
    case 'NIGHT': return 'Night';
    default: return label;
  }
}
