---
name: self-evolve Module 2 Dashboard
description: Restrained, dense product dashboard for triaging Pi agent sessions.
colors:
  primary: "#d63384"
  neutral-bg: "#121212"
  neutral-surface: "#1e1e1e"
  neutral-text: "#e0e0e0"
  neutral-text-dim: "#a0a0a0"
  status-error: "#ef4444"
  status-warning: "#f59e0b"
typography:
  display:
    fontFamily: "system-ui, -apple-system, sans-serif"
    fontSize: "1.5rem"
    fontWeight: 600
  body:
    fontFamily: "system-ui, -apple-system, sans-serif"
    fontSize: "0.875rem"
    fontWeight: 400
  label:
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace"
    fontSize: "0.75rem"
    fontWeight: 500
rounded:
  sm: "4px"
  md: "8px"
spacing:
  sm: "8px"
  md: "16px"
components:
  badge-error:
    backgroundColor: "{colors.status-error}"
    textColor: "#ffffff"
    rounded: "{rounded.sm}"
    padding: "4px 8px"
    typography: "{typography.label}"
  badge-warning:
    backgroundColor: "{colors.status-warning}"
    textColor: "#ffffff"
    rounded: "{rounded.sm}"
    padding: "4px 8px"
    typography: "{typography.label}"
  table-cell:
    padding: "8px 12px"
    typography: "{typography.body}"
---

# Design System: self-evolve Module 2 Dashboard

## 1. Overview

**Creative North Star: "The Operator's Console"**

This dashboard is a restrained, data-dense interface designed for technical operators triaging Pi agent sessions. Following our chosen inspiration of `design-md/sentry/README.md`, it prioritizes a dark, dense layout with pink-purple accents used strictly for critical actions or active states. It explicitly rejects playful branding, finance-style trading layouts, and "AI Magic" animations. The interface is built on the current read-only contract of Module 1: it handles missing data gracefully and refuses to invent confidence where none exists.

**Key Characteristics:**
- Dark mode by default for sustained technical use.
- High data density focused on tables and metric grids.
- Utilitarian typography with monospace for exact data.
- Strict mapping of status colors (red/yellow) to derived health states.

## 2. Colors

A dark, low-contrast foundation punctuated by stark status indicators and a single primary accent.

### Primary
- **Operator Accent** (`#d63384`): Used sparingly for critical actions (e.g., selecting a baseline) or defining active state focus.

### Neutral
- **Background** (`#121212`): The deepest void for the main app canvas.
- **Surface** (`#1e1e1e`): Slightly raised layer for cards and table rows.
- **Text Main** (`#e0e0e0`): High-legibility body text.
- **Text Dim** (`#a0a0a0`): Secondary metadata, timestamps, and "Not recorded" fallbacks.

### Status (Semantic)
- **Error/Incomplete** (`#ef4444`): Unambiguous failure states and incomplete extractions.
- **Warning** (`#f59e0b`): Cautionary states like `Extraction Weird` or `Retry Storm`.

**The Restraint Rule.** The primary accent (`#d63384`) must cover less than 5% of any given screen. Its rarity is what gives it triage power.

## 3. Typography

**Display Font:** System UI Sans
**Body Font:** System UI Sans
**Label/Mono Font:** System Monospace

**Character:** Completely utilitarian and native to the operator's OS environment, ensuring metrics align perfectly.

### Hierarchy
- **Display** (600, 1.5rem): Dashboard and detail view headers.
- **Headline** (500, 1.25rem): Section groupings (e.g., Timeline vs. Tool Usage).
- **Body** (400, 0.875rem): Standard table data and paragraph copy.
- **Label** (500, 0.75rem, mono): Exact values (tokens, duration, IDs) and status badges.

**The Exact Truth Rule.** Any absolute numeric metric, identifier, or duration must use the monospace label font.

## 4. Elevation

The system is primarily flat, relying on tonal contrast between the void background and surface layers to establish hierarchy. Shadows are avoided to maintain data density.

**The Flat-By-Default Rule.** Surfaces are flat at rest. Depth is conveyed purely through the background (`#121212`) vs. surface (`#1e1e1e`) color shifts.

## 5. Components

### Tables
- **Cell Padding:** Tight (`8px 12px`) to maximize vertical row density.
- **Empty States:** When a field is missing per the Module 1 contract, the cell renders "Not recorded" in `Text Dim` (`#a0a0a0`). Do not infer zeros.

### Status Badges
- **Shape:** Tight rounded rectangle (4px radius).
- **Typography:** Uppercase monospace label.
- **Error Variant:** Red background (`#ef4444`), white text. Triggered by `Incomplete`.
- **Warning Variant:** Yellow background (`#f59e0b`), white text. Triggered by derived flags like `Extraction Weird`.

### Metric Cards
- **Corner Style:** 8px radius.
- **Background:** Surface (`#1e1e1e`).
- **Layout:** Dense label above a large monospace metric value.

### Caveat Banners
- **Style:** Full-width surface blocks with a warning accent border.
- **Usage:** Used when data is incomparable (e.g., "Task similarity unknown").

## 6. Do's and Don'ts

Guardrails to ensure the product register and data-dense intent are maintained.

### Do:
- **Do** align to the dense, dark-mode, pink-purple accented aesthetic established by `design-md/sentry/README.md`.
- **Do** use strict `Not recorded` strings when Module 1 contract data is missing.
- **Do** use monospace fonts for all identifiers, token counts, and durations.

### Don't:
- **Don't** use playful or whimsical UI elements (e.g., PostHog).
- **Don't** build finance/trading style dashboards (e.g., Kraken).
- **Don't** use "AI Magic" glowing/animated recommendations.
- **Don't** invent faux certainty; if similarity is unknown, render the caveat banner instead of inventing a confidence score.
