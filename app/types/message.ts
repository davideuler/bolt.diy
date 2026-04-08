/**
 * Compatibility type for ai@6 migration.
 *
 * In ai@6, the old `Message` type is replaced by `UIMessage`.
 * `UIMessage` uses `parts` instead of `content` and drops `annotations`.
 * This shim extends UIMessage with the legacy fields so existing code
 * throughout the codebase keeps compiling without a full rewrite.
 */
import type { UIMessage, JSONValue } from 'ai';

export type Message = UIMessage & {
  /** Legacy content field - UIMessage uses parts instead */
  content?: string;

  /** Legacy annotations field */
  annotations?: JSONValue[];

  /** Legacy createdAt field */
  createdAt?: Date;
};
