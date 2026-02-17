## Diagnosis and Suggested Fix

### Symptoms

Three distinct markdown rendering issues exist in the chat UI:

1. **Code blocks**: Fenced code blocks (triple-backtick) do not reliably render as styled code blocks with syntax highlighting and a copy button. They may fall back to plain `<pre><code>` output.
2. **Thinking bubble markdown**: The thinking/thought bubble shown during streaming does not render inline markdown formatting — `**bold**`, `_italic_`, etc. appear as raw syntax or unstyled text.
3. **Table text overflow**: Text in markdown tables that contains no natural line breaks extends beyond the cell boundaries instead of wrapping, causing horizontal overflow.

---

### Root Cause Analysis

#### Issue 1 — Code blocks: Fragile global `marked` configuration

**Files involved:**
- `src/app/features/chat/message-bubble/message-bubble.component.ts` (lines 14–39)
- `src/app/features/tasks/task-detail/task-detail.component.ts` (line 24)

The app configures `marked` by calling `marked.setOptions()` at the **module top level** in two separate files:

```typescript
// message-bubble.component.ts — sets custom renderer with code block support
const renderer = new Renderer();
renderer.code = function(code, infostring) { /* custom HTML with hljs + copy button */ };
marked.setOptions({ breaks: true, gfm: true, renderer });

// task-detail.component.ts — sets options WITHOUT the custom renderer
marked.setOptions({ breaks: true, gfm: true });
```

`marked` is a **singleton module** — both files share the same `marked` object. The problem is that `marked.setOptions()` is a **"last writer wins"** call on shared global state. Which call runs last depends on ES module import graph evaluation order, which is determined by the Angular bundler (esbuild). If `task-detail.component.ts` initializes after `message-bubble.component.ts`, the global options are overwritten.

While testing shows that `marked` v12 does *preserve* previously-set options not included in a later `setOptions()` call, this behavior is an implementation detail and not guaranteed. The fundamental issue is **relying on module-level side effects on a shared singleton** — which is inherently order-dependent and fragile. Any additional future call to `marked.setOptions()` or `marked.use()` anywhere in the app can break code block rendering.

Additionally, there is no dedicated `Marked` instance per component, so there's no isolation between chat markdown (which needs the custom code-block renderer) and task-detail markdown (which only needs basic rendering).

#### Issue 2 — Thinking bubble: Block elements inside `<span>` (invalid HTML)

**Files involved:**
- `src/app/features/chat/message-list/message-list.component.html` (line 38)
- `src/app/features/chat/message-list/message-list.component.ts` (lines 62–64)
- `src/app/features/chat/message-list/message-list.component.scss` (lines 120–139)

The thinking bubble renders markdown via:

```html
<span class="thinking-text" [innerHTML]="renderThinking(latestThinking())"></span>
```

`renderThinking()` calls `marked.parse()`, which wraps output in block-level `<p>` tags:

```html
<!-- marked.parse('**bold** and _italic_') produces: -->
<p><strong>bold</strong> and <em>italic</em></p>
```

A `<p>` element **cannot** be a child of a `<span>` element — this is invalid HTML per the spec. When the browser encounters this, it **restructures the DOM** by closing the `<span>` early:

```html
<!-- What Angular sets: -->
<span class="thinking-text"><p><strong>bold</strong> and <em>italic</em></p></span>

<!-- What the browser actually renders: -->
<span class="thinking-text"></span>
<p><strong>bold</strong> and <em>italic</em></p>
```

This breaks **all** the CSS rules targeting `.thinking-text` descendants:

```scss
:host ::ng-deep .thinking-text {
  strong { font-weight: 700; }  // ← never matches, <strong> is OUTSIDE .thinking-text
  em { font-style: italic; }    // ← never matches
  code { ... }                   // ← never matches
}
```

The `<strong>`, `<em>`, and other tags are rendered by `marked` correctly, but the CSS can't reach them because the browser moved them out of the `.thinking-text` span.

#### Issue 3 — Table word-wrap: Missing overflow containment

**Files involved:**
- `src/app/features/chat/message-bubble/message-bubble.component.scss` (lines 255–274)

The table CSS is:

```scss
:host ::ng-deep .text-content {
  table {
    table-layout: fixed;
    width: 100%;

    th, td {
      overflow-wrap: break-word;
      word-break: break-word;
      white-space: normal;
    }
  }
}
```

While this handles most cases, there are two problems:

1. **No `overflow-x` on the container.** Neither `.text-content`, `.message-body`, nor `.message-content` has `overflow-x: auto`. If a table overflows for any reason (many columns, embedded `<code>` elements with UA-default `white-space: pre`, etc.), the content extends beyond the container with no scroll mechanism.

2. **`table-layout: fixed` is overly rigid.** It distributes column widths equally (1/N) regardless of content. For tables with many columns in a narrow container, or tables where one column has substantially more content than others, the equal distribution can force cells narrower than their content needs, causing overflow despite `word-break: break-word`. Additionally, `<code>` elements inside table cells may have the browser's user-agent default of `white-space: pre` or `white-space: nowrap`, which overrides the cell's `white-space: normal`.

---

### Suggested Fix

#### Fix 1 — Code blocks: Use an isolated `Marked` instance

Replace the fragile global `setOptions` approach with isolated `Marked` instances per component. This eliminates cross-module interference entirely.

**`src/app/features/chat/message-bubble/message-bubble.component.ts`:**

```typescript
import { Marked, Renderer } from 'marked';
import hljs from 'highlight.js';

// Create an isolated marked instance for chat rendering
const renderer = new Renderer();
renderer.code = function(code: string, infostring: string | undefined): string {
  // ... existing custom code block logic (unchanged) ...
};

const chatMarked = new Marked({ breaks: true, gfm: true, renderer });

// In the component class:
renderMarkdown(text: string): string {
  return chatMarked.parse(text, { async: false }) as string;
}
```

**`src/app/features/tasks/task-detail/task-detail.component.ts`:**

```typescript
import { Marked } from 'marked';

const taskMarked = new Marked({ breaks: true, gfm: true });

// In the component class:
renderMarkdown(text: string): string {
  return taskMarked.parse(text, { async: false }) as string;
}
```

**`src/app/features/chat/message-list/message-list.component.ts`:**

```typescript
import { Marked } from 'marked';

const thinkingMarked = new Marked({ breaks: true, gfm: true });

renderThinking(text: string): string {
  return thinkingMarked.parse(text, { async: false }) as string;
}
```

This ensures each component has its own `Marked` instance with the exact configuration it needs, with no shared global state.

#### Fix 2 — Thinking bubble: Change `<span>` to `<div>`

**`src/app/features/chat/message-list/message-list.component.html`** (line 38):

```html
<!-- Before -->
<span class="thinking-text" [innerHTML]="renderThinking(latestThinking())"></span>

<!-- After -->
<div class="thinking-text" [innerHTML]="renderThinking(latestThinking())"></div>
```

A `<div>` is a block-level element that can legally contain `<p>`, `<strong>`, `<em>`, and all other block/inline elements that `marked.parse()` produces. The CSS selectors under `.thinking-text` will now match correctly.

**Alternative (if inline layout is desired):** Use `marked.parseInline()` instead of `marked.parse()` to avoid generating block-level elements:

```typescript
renderThinking(text: string): string {
  return thinkingMarked.parseInline(text, { async: false }) as string;
}
```

`parseInline()` renders inline markup (`**bold**` → `<strong>bold</strong>`) without wrapping in `<p>` tags, which is safe inside a `<span>`. However, this loses support for block-level constructs (lists, headings) which are unlikely in thinking content anyway.

#### Fix 3 — Tables: Add overflow scroll and fix code wrapping

**`src/app/features/chat/message-bubble/message-bubble.component.scss`:**

```scss
:host ::ng-deep .text-content {
  // Add overflow containment for wide content (tables, code blocks)
  overflow-x: auto;

  table {
    border-collapse: collapse;
    margin: 8px 0;
    width: 100%;
    table-layout: fixed;

    th, td {
      border: 1px solid var(--border-color, rgba(255, 255, 255, 0.15));
      padding: 4px 8px;
      text-align: left;
      overflow-wrap: break-word;
      word-break: break-word;
      white-space: normal;

      // Ensure code elements inside cells can wrap too
      code {
        white-space: pre-wrap;
        word-break: break-all;
      }
    }

    th {
      font-weight: 600;
      background-color: var(--bg-tertiary, rgba(255, 255, 255, 0.05));
    }
  }
}
```

Key changes:
- **`overflow-x: auto`** on `.text-content` — provides a horizontal scrollbar as a safety net if content exceeds container width.
- **`code { white-space: pre-wrap; word-break: break-all; }`** inside `th, td` — ensures inline `<code>` elements within table cells respect word-wrapping instead of inheriting the browser's UA default of `white-space: pre`.

---

### Verification Steps

1. **Code blocks**: Send a chat message containing a fenced code block (e.g., ` ```js\nconsole.log("hello")\n``` `). Verify:
   - It renders as a styled code block with dark background, language label, and syntax highlighting.
   - A copy button appears in the code block header.
   - Clicking the copy button copies the code text to the clipboard and shows a checkmark for 1.5 seconds.

2. **Thinking bubble markdown**: Trigger agent work that produces thinking output containing `**bold**` or `_italic_` text. Verify:
   - Bold text appears in heavier font weight.
   - Italic text appears with italic styling (beyond the ambient italic of the thinking bubble).
   - Inline `code` renders with a background highlight.

3. **Table word-wrap**: Send a message that produces a markdown table with long text in cells (no natural whitespace breaks). Verify:
   - Cell text wraps within the cell boundaries.
   - No horizontal scrollbar appears on the message container (text wraps instead).
   - If a table is intentionally very wide (10+ columns), a horizontal scrollbar appears on the text content area rather than the entire page.

4. **Regression check**: Verify that:
   - Task detail markdown (description tab) still renders correctly.
   - Research content markdown in task detail still renders correctly.
   - All existing inline markdown (bold, italic, links, lists, headings, blockquotes) in chat messages still renders correctly.
