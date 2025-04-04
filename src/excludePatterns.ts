/**
 * Type definition for comment exclusion patterns
 */
export type ExcludePattern = RegExp;

/**
 * Exclusion patterns for comments that should not be removed.
 * Add new patterns here to maintain specific types of comments.
 */
export const excludePatterns: ExcludePattern[] = [
  // JavaScript/JSX
  /eslint-/i, // eslint comments
  /jshint/i, // JSHint directives
  /jslint/i, // JSLint directives
  /globals/i, // Globals directives
  /exported/i, // Exported directives
  /@jsx/i, // JSX pragmas
  /@react-/i, // React specific comments
  /istanbul/i, // Istanbul directives
  /prettier-ignore/i, // Prettier ignore directives
  /@jest-environment/i, // Jest environment pragma

  // TypeScript
  /@ts-/i, // TypeScript directives
  /@ts-nocheck/i, // TypeScript no-check
  /flow/i, // Flow type directives
  /@flow/i, // Flow type comments

  // Python
  /type:\s*ignore/i, // Python type ignore
  /pragma/i, // Pragma comments
  /noqa/i, // Python noqa comments
  /pylint:/i, // Pylint directives
  /coding:/i, // Python coding directives
  /ruff:/i, // Ruff directives
  /type:\s*mypy/i, // Mypy type directives
];
