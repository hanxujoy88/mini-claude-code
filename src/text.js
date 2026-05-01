export function trimOutput(text, max = 12000) {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n... output truncated ...`;
}
