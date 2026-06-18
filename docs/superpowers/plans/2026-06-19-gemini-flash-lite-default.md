# Gemini 2.5 Flash Lite Default Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `gemini-2.5-flash-lite` to analysis model selection and use it for all newly created or missing analysis model settings without changing existing database rows.

**Architecture:** Keep the existing string-based model configuration contract. Change the server fallback, client empty-state default, development seed data, and fresh-database migration seed while retaining `ON CONFLICT DO NOTHING`, so previously stored model choices remain untouched.

**Tech Stack:** TypeScript, React 19, Vitest, Drizzle ORM, PostgreSQL migrations

---

## File Structure

- Modify `lib/db/queries.ts`: change the server-side missing/new configuration fallback.
- Modify `lib/db/__tests__/queries.test.ts`: verify fallback creation and preservation of explicit models.
- Modify `src/pages/Settings.tsx`: expose Flash Lite and make it the client empty-state default.
- Modify `src/pages/__tests__/Settings.test.tsx`: verify model option/default behavior and existing selection preservation.
- Modify `lib/db/seed.ts`: align development seed configurations and mock analysis metadata.
- Modify `lib/db/__tests__/seed.test.ts`: assert seeded model IDs.
- Modify `src/mocks/handlers.ts`: align mock-mode analysis configuration defaults.
- Modify `drizzle/0010_cron_analysis_reliability.sql`: use Flash Lite only when building a fresh database.
- Modify `lib/db/__tests__/migrate.test.ts`: verify the fresh-database seed remains non-destructive.

### Task 1: Server Analysis Configuration Default

**Files:**

- Modify: `lib/db/__tests__/queries.test.ts:190-310`
- Modify: `lib/db/queries.ts:47-89`

- [ ] **Step 1: Change query tests to require the Flash Lite fallback**

Update the three fallback expectations:

```ts
modelId: 'gemini-2.5-flash-lite',
```

Retain the explicit-model assertion:

```ts
expect(db._chain.values).toHaveBeenCalledWith({
    analysisType: 'technical',
    enabled: true,
    modelId: 'claude-4',
    useByok: false,
    updatedAt: expect.any(Date),
});
```

This verifies that only omitted model IDs use the new default.

- [ ] **Step 2: Run the focused query tests and verify failure**

Run:

```bash
yarn vitest run lib/db/__tests__/queries.test.ts
```

Expected: FAIL because `getAnalysisConfig` and `updateAnalysisConfig` still return or insert `gemini-2.5-flash`.

- [ ] **Step 3: Change the server fallback constant**

In `lib/db/queries.ts`, replace the constant with:

```ts
// Default model when no analysis_model_config row exists. Keep in sync with src/pages/Settings.tsx MODELS[0].
const DEFAULT_ANALYSIS_MODEL = 'gemini-2.5-flash-lite';
```

Do not change the conflict update behavior; `setValues` must continue to exclude omitted fields so an existing row's model remains unchanged.

- [ ] **Step 4: Run the focused query tests**

Run:

```bash
yarn vitest run lib/db/__tests__/queries.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit the server default**

```bash
git add lib/db/queries.ts lib/db/__tests__/queries.test.ts
git commit -m "feat: default analysis config to flash lite"
```

### Task 2: Settings Model Selection

**Files:**

- Modify: `src/pages/__tests__/Settings.test.tsx:111-190,616-635`
- Modify: `src/pages/Settings.tsx:20-28`

- [ ] **Step 1: Add tests for the option and empty-state default**

Add a test that preserves the existing configured model while exposing the new option:

```ts
it('offers Gemini Flash Lite without replacing an existing model selection', async () => {
    mockedApi.getConfig.mockResolvedValue(mockConfig);

    renderWithQuery(<SettingsPage />);

    await waitFor(() => {
        expect(screen.getByText('분석 설정')).toBeInTheDocument();
    });

    const technicalSelect = screen.getAllByRole('combobox').find(
        (select) => (select as HTMLSelectElement).value === 'gemini-2.5-flash',
    );
    expect(technicalSelect).toHaveValue('gemini-2.5-flash');
    expect(
        within(technicalSelect!).getByRole('option', { name: 'gemini-2.5-flash-lite' }),
    ).toBeInTheDocument();
});
```

Import `within` from `@testing-library/react` if it is not already imported.

Add an empty-analysis test:

```ts
it('uses Gemini Flash Lite for empty analysis configuration', async () => {
    mockedApi.getConfig.mockResolvedValue({ ...mockConfig, analysis: [] });

    renderWithQuery(<SettingsPage />);

    await waitFor(() => {
        expect(screen.getAllByDisplayValue('gemini-2.5-flash-lite')).toHaveLength(4);
    });
});
```

- [ ] **Step 2: Run the focused settings tests and verify failure**

Run:

```bash
yarn vitest run src/pages/__tests__/Settings.test.tsx
```

Expected: FAIL because Flash Lite is not in `MODELS` and empty rows still default to Flash.

- [ ] **Step 3: Add Flash Lite as the first selectable model**

Change the model list in `src/pages/Settings.tsx` to:

```ts
const MODELS = [
    'gemini-2.5-flash-lite',
    'gemini-2.5-flash',
    'gemini-2.5-pro',
    'claude-sonnet-4-6',
    'claude-opus-4-7',
    'gpt-5-mini',
    'gpt-5.4',
] as const;
```

The existing empty-state expression `modelId: MODELS[0]` then uses Flash Lite. API-provided `modelId` values remain unchanged.

- [ ] **Step 4: Run the focused settings tests**

Run:

```bash
yarn vitest run src/pages/__tests__/Settings.test.tsx
```

Expected: PASS.

- [ ] **Step 5: Commit the settings change**

```bash
git add src/pages/Settings.tsx src/pages/__tests__/Settings.test.tsx
git commit -m "feat: add flash lite analysis option"
```

### Task 3: Seed and Fresh-Database Defaults

**Files:**

- Modify: `lib/db/__tests__/seed.test.ts:50-64,131-146`
- Modify: `lib/db/__tests__/migrate.test.ts:48-68`
- Modify: `lib/db/seed.ts:47-54,226-232`
- Modify: `src/mocks/handlers.ts:68-100`
- Modify: `drizzle/0010_cron_analysis_reliability.sql:21-28`

- [ ] **Step 1: Strengthen seed and migration tests**

Extend the analysis model seed assertion:

```ts
expect(modelConfigCalls).toHaveLength(4);
expect(modelConfigCalls.every(([value]) => value.modelId === 'gemini-2.5-flash-lite')).toBe(
    true,
);
```

Extend the mock analysis result assertion:

```ts
expect(analysisCalls).toHaveLength(20);
expect(analysisCalls.every(([value]) => value.modelId === 'gemini-2.5-flash-lite')).toBe(true);
```

Add migration assertions:

```ts
it('uses Flash Lite for fresh database analysis configs', () => {
    expect(sql.match(/'gemini-2\.5-flash-lite'/g)).toHaveLength(4);
});

it('does not overwrite existing analysis model configs', () => {
    expect(sql).toContain(`ON CONFLICT ("analysis_type") DO NOTHING`);
    expect(sql).not.toMatch(/UPDATE\s+"analysis_model_config"/i);
});
```

- [ ] **Step 2: Run seed and migration tests and verify failure**

Run:

```bash
yarn vitest run lib/db/__tests__/seed.test.ts lib/db/__tests__/migrate.test.ts
```

Expected: FAIL because seed and migration values still contain older models.

- [ ] **Step 3: Align development seed and mock data**

Set all four entries in `lib/db/seed.ts` to:

```ts
{ analysisType: '<type>', modelId: 'gemini-2.5-flash-lite', enabled: true, useByok: true }
```

Set seeded mock analysis results to:

```ts
modelId: 'gemini-2.5-flash-lite',
```

Set all four `analysisConfigs` entries in `src/mocks/handlers.ts` to:

```ts
modelId: 'gemini-2.5-flash-lite',
```

- [ ] **Step 4: Change only the fresh-database migration insert values**

In `drizzle/0010_cron_analysis_reliability.sql`, use:

```sql
VALUES
    ('technical', true, 'gemini-2.5-flash-lite', false),
    ('news', true, 'gemini-2.5-flash-lite', false),
    ('options', true, 'gemini-2.5-flash-lite', false),
    ('fundamental', true, 'gemini-2.5-flash-lite', false)
ON CONFLICT ("analysis_type") DO NOTHING;
```

Do not add an `UPDATE`. Databases that already applied migration `0010` retain their rows, and seed reruns also preserve them through `onConflictDoNothing()`.

- [ ] **Step 5: Run seed and migration tests**

Run:

```bash
yarn vitest run lib/db/__tests__/seed.test.ts lib/db/__tests__/migrate.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit seed and migration defaults**

```bash
git add lib/db/seed.ts lib/db/__tests__/seed.test.ts src/mocks/handlers.ts drizzle/0010_cron_analysis_reliability.sql lib/db/__tests__/migrate.test.ts
git commit -m "chore: align fresh analysis data with flash lite"
```

### Task 4: Full Verification

**Files:**

- Verify only; no planned source changes.

- [ ] **Step 1: Run all directly related tests**

Run:

```bash
yarn vitest run src/pages/__tests__/Settings.test.tsx lib/db/__tests__/queries.test.ts lib/db/__tests__/seed.test.ts lib/db/__tests__/migrate.test.ts
```

Expected: PASS.

- [ ] **Step 2: Run TypeScript validation**

Run:

```bash
yarn typecheck
```

Expected: exit code 0.

- [ ] **Step 3: Run lint on changed TypeScript files**

Run:

```bash
yarn eslint src/pages/Settings.tsx src/pages/__tests__/Settings.test.tsx src/mocks/handlers.ts lib/db/queries.ts lib/db/seed.ts lib/db/__tests__/queries.test.ts lib/db/__tests__/seed.test.ts lib/db/__tests__/migrate.test.ts
```

Expected: exit code 0.

- [ ] **Step 4: Check formatting and whitespace**

Run:

```bash
yarn prettier --check src/pages/Settings.tsx src/pages/__tests__/Settings.test.tsx src/mocks/handlers.ts lib/db/queries.ts lib/db/seed.ts lib/db/__tests__/queries.test.ts lib/db/__tests__/seed.test.ts lib/db/__tests__/migrate.test.ts drizzle/0010_cron_analysis_reliability.sql
git diff --check
```

Expected: both commands exit with code 0.

- [ ] **Step 5: Confirm no existing-row migration was introduced**

Run:

```bash
git diff -- drizzle/0010_cron_analysis_reliability.sql drizzle/meta
```

Expected: only the four insert model values change; there is no `UPDATE` and no new migration or metadata file.

- [ ] **Step 6: Commit any verification-only formatting fix**

If formatting changed files, run:

```bash
git add src/pages/Settings.tsx src/pages/__tests__/Settings.test.tsx src/mocks/handlers.ts lib/db/queries.ts lib/db/seed.ts lib/db/__tests__/queries.test.ts lib/db/__tests__/seed.test.ts lib/db/__tests__/migrate.test.ts drizzle/0010_cron_analysis_reliability.sql
git commit -m "style: format flash lite default changes"
```

If no files changed, skip this commit.
