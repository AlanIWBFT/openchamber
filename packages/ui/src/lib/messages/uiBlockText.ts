import type { Part, TextPart } from '@/lib/opencode/model';

// Shared by timeline hoisting and sync snapshot invalidation. A literal fence
// remains a code sample; an opening UI fence is structural even before it closes.
export const isUiBlockTextPart = (part: Part): part is TextPart => (
  part.type === 'text' && /^ {0,3}(`{3,}|~{3,})openui-lang[ \t]*$/m.test(part.text)
);
