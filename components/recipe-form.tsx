import { ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  InputAccessoryView,
  Keyboard,
  KeyboardAvoidingView,
  LayoutChangeEvent,
  Platform,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useTranslation } from 'react-i18next';

import { useRouter } from 'expo-router';

import { IngredientPicker } from '@/components/ingredient-picker';
import { useAuth } from '@/lib/auth-context';
import { useProfile } from '@/lib/queries/profile';
import { RecipeInput } from '@/lib/queries/recipes';
import {
  RECIPE_CATEGORIES,
  type RecipeCategory,
  isRecipeCategory,
} from '@/lib/recipe-categories';
import {
  detectRecipeLanguage,
  RECIPE_LANGUAGE_LABEL,
  type RecipeLanguage,
} from '@/lib/recipe-language';
import {
  clearRecipeDraft,
  formatDraftAge,
  loadRecipeDraft,
  saveRecipeDraft,
} from '@/lib/recipe-drafts';
import { useUiLanguage } from '@/lib/ui-language';

type IngredientRow = {
  ingredient_id: string; // '' when pending resolution
  ingredient_name: string; // canonical name when resolved, raw text when pending
  qty: string;
  unit: string;
  notes: string;
  /** Set when the row came from an import that couldn't match the catalog;
   *  the user resolves by tapping and picking/creating an ingredient. */
  pending?: {
    raw: string; // original ingredient line
    searchName: string; // cleaned name for picker pre-fill
  };
  /** Sticky reference to the original imported line, kept across pending
   *  resolution so the user can compare their entered qty/unit against
   *  what the recipe originally said. */
  from_import?: { raw: string };
};

export type RecipeFormInitialIngredient = {
  ingredient_id: string; // '' for pending
  ingredient_name: string;
  qty: number;
  unit: string;
  notes?: string | null;
  pending?: {
    raw: string;
    searchName: string;
  };
  from_import?: { raw: string };
};

export type RecipeFormInitial = {
  title: string;
  description: string | null;
  servings: number;
  prep_min: number | null;
  cook_min: number | null;
  instructions: string[];
  visibility?: 'private' | 'public';
  category?: RecipeCategory | null;
  tags?: string[];
  language?: RecipeLanguage | null;
  ingredients: RecipeFormInitialIngredient[];
};

type Props = {
  initial?: RecipeFormInitial;
  submitting: boolean;
  submitLabel: string;
  onSubmit: (input: RecipeInput) => Promise<void> | void;
  /** Rendered above all form fields inside the scroll view. */
  header?: ReactNode;
  /** Fires once when the user first changes any field from its initial value.
   *  Lets the parent prompt before replacing form state (e.g. re-import). */
  onUserEdit?: () => void;
  /** When set, enables AsyncStorage-backed draft autosave for this form.
   *  Conventions: 'new' for the new-recipe screen, 'edit:<id>' for edits.
   *  On mount the form attempts to restore from AsyncStorage; subsequent
   *  edits are debounced-saved every 500ms; the draft is cleared on
   *  successful submit. Omit to disable autosave (e.g. preview surfaces). */
  draftKey?: string;
};

export function RecipeForm({
  initial,
  submitting,
  submitLabel,
  onSubmit,
  header,
  onUserEdit,
  draftKey,
}: Props) {
  const router = useRouter();
  const { isGuest } = useAuth();
  const { t } = useTranslation('recipe-form');
  const { t: tCommon } = useTranslation('common');
  // Display name is the byline on public recipes. Without one set, public
  // attribution falls back to "the community" (see app/(tabs)/discover.tsx)
  // — anonymous publishing isn't allowed by App Store UGC norms because it
  // removes the accountability hook (report → reviewer can act on author).
  // Treat profile-loading as "no name yet" so the publish toggle stays
  // locked until we know for sure; staleTime in useProfile caches it.
  const profile = useProfile();
  const hasDisplayName = !!profile.data?.display_name?.trim();
  const [title, setTitle] = useState(initial?.title ?? '');
  const [description, setDescription] = useState(initial?.description ?? '');
  // Default servings = explicit initial > onboarding household_size > 2.
  // The household_size is captured at onboarding (1-8) and reflects the
  // user's actual cooking household; defaulting to that saves them a
  // tap on every new recipe. Falls back to 2 if profile hasn't loaded
  // yet or hasn't been set.
  const [servings, setServings] = useState(
    String(initial?.servings ?? profile.data?.household_size ?? 2),
  );
  const [prepMin, setPrepMin] = useState(initial?.prep_min != null ? String(initial.prep_min) : '');
  const [cookMin, setCookMin] = useState(initial?.cook_min != null ? String(initial.cook_min) : '');
  const [instructions, setInstructions] = useState<string[]>(initial?.instructions ?? []);
  const [visibility, setVisibility] = useState<'private' | 'public'>(
    initial?.visibility ?? 'private',
  );
  const [category, setCategory] = useState<RecipeCategory | null>(
    initial?.category ?? null,
  );
  const [tags, setTags] = useState<string[]>(initial?.tags ?? []);
  const [tagDraft, setTagDraft] = useState('');
  // Language override: null = use mutation's auto-detect on submit.
  // Explicit value = user overrode the heuristic (or the recipe was
  // imported/cloned with a known language). The chip below surfaces
  // only when the effective language disagrees with the UI language
  // — most users never see it.
  const [uiLanguage] = useUiLanguage();
  const [languageOverride, setLanguageOverride] = useState<RecipeLanguage | null>(
    initial?.language ?? null,
  );
  const [rows, setRows] = useState<IngredientRow[]>(
    initial?.ingredients.map((i) => ({
      ingredient_id: i.ingredient_id,
      ingredient_name: i.ingredient_name,
      qty: i.qty > 0 ? String(i.qty) : '',
      unit: i.unit,
      notes: i.notes ?? '',
      pending: i.pending,
      from_import: i.from_import ?? (i.pending ? { raw: i.pending.raw } : undefined),
    })) ?? [],
  );

  // When pickerTarget is a number, picking resolves that row's pending state.
  // When null, picking appends a new row.
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerTarget, setPickerTarget] = useState<number | null>(null);
  const [pickerInitialQuery, setPickerInitialQuery] = useState<string | undefined>(
    undefined,
  );

  // ───── Draft autosave ─────
  // restoreAttempted gates the autosave effect — we MUST finish the
  // load-from-AsyncStorage before letting the autosave overwrite it. If
  // no draftKey is provided, autosave is disabled entirely; start with
  // restoreAttempted=true so the autosave effect early-returns cleanly.
  const [restoreAttempted, setRestoreAttempted] = useState(!draftKey);
  const [draftRestoredAt, setDraftRestoredAt] = useState<number | null>(null);

  // Restore-on-mount: if a draft exists, hydrate form state from it and
  // surface a "Restored unsaved changes from <time>" banner so the user
  // knows they're not looking at the original initial state.
  useEffect(() => {
    if (!draftKey || restoreAttempted) return;
    let cancelled = false;
    (async () => {
      const draft = await loadRecipeDraft(draftKey);
      if (cancelled) return;
      if (draft) {
        setTitle(draft.title);
        setDescription(draft.description);
        setServings(draft.servings);
        setPrepMin(draft.prepMin);
        setCookMin(draft.cookMin);
        setInstructions(draft.instructions);
        setVisibility(draft.visibility);
        // Older drafts (pre-Q2) won't have category/tags — fall back to
        // null / empty array instead of restoring undefined into state.
        setCategory(isRecipeCategory(draft.category) ? draft.category : null);
        setTags(Array.isArray(draft.tags) ? draft.tags : []);
        setRows(draft.rows as IngredientRow[]);
        setDraftRestoredAt(draft.savedAt);
      }
      setRestoreAttempted(true);
    })();
    return () => {
      cancelled = true;
    };
  }, [draftKey, restoreAttempted]);

  // Debounced autosave: writes the current form state to AsyncStorage
  // 500ms after the user stops typing. If the form is completely empty
  // (no title/description/instructions/rows), clear any stale draft so
  // we don't leave a phantom "Restore from 5 minutes ago" banner the
  // next time the user opens the form.
  useEffect(() => {
    if (!draftKey || !restoreAttempted) return;
    const t = setTimeout(() => {
      const isEmpty =
        !title.trim() &&
        !description.trim() &&
        instructions.every((s) => !s.trim()) &&
        rows.length === 0;
      if (isEmpty) {
        clearRecipeDraft(draftKey);
      } else {
        saveRecipeDraft(draftKey, {
          title,
          description,
          servings,
          prepMin,
          cookMin,
          instructions,
          visibility,
          category,
          tags,
          rows,
        });
      }
    }, 500);
    return () => clearTimeout(t);
  }, [
    draftKey,
    restoreAttempted,
    title,
    description,
    servings,
    prepMin,
    cookMin,
    instructions,
    visibility,
    category,
    tags,
    rows,
  ]);

  // Explicit "Discard draft" — confirm dialog, then wipe the storage row
  // and reset the form to the initial state (or empty if no initial).
  const handleDiscardDraft = () => {
    Alert.alert(
      t('draft.discardAlertTitle'),
      t('draft.discardAlertBody'),
      [
        { text: tCommon('cancel'), style: 'cancel' },
        {
          text: t('draft.discardAlertConfirm'),
          style: 'destructive',
          onPress: async () => {
            if (draftKey) await clearRecipeDraft(draftKey);
            setTitle(initial?.title ?? '');
            setDescription(initial?.description ?? '');
            setServings(
              String(initial?.servings ?? profile.data?.household_size ?? 2),
            );
            setPrepMin(
              initial?.prep_min != null ? String(initial.prep_min) : '',
            );
            setCookMin(
              initial?.cook_min != null ? String(initial.cook_min) : '',
            );
            setInstructions(initial?.instructions ?? []);
            setVisibility(initial?.visibility ?? 'private');
            setCategory(initial?.category ?? null);
            setTags(initial?.tags ?? []);
            setTagDraft('');
            setLanguageOverride(initial?.language ?? null);
            setRows(
              initial?.ingredients.map((i) => ({
                ingredient_id: i.ingredient_id,
                ingredient_name: i.ingredient_name,
                qty: i.qty > 0 ? String(i.qty) : '',
                unit: i.unit,
                notes: i.notes ?? '',
                pending: i.pending,
                from_import:
                  i.from_import ?? (i.pending ? { raw: i.pending.raw } : undefined),
              })) ?? [],
            );
            setDraftRestoredAt(null);
          },
        },
      ],
    );
  };

  // Dirty tracking: parent wants to know when the user edits anything so it
  // can confirm before an import overwrites their work. We skip the first
  // "change" — that's just state initialization from `initial`.
  const firstRenderRef = useRef(true);
  const dirtyFiredRef = useRef(false);
  useEffect(() => {
    if (firstRenderRef.current) {
      firstRenderRef.current = false;
      return;
    }
    if (dirtyFiredRef.current) return;
    dirtyFiredRef.current = true;
    onUserEdit?.();
  }, [title, description, servings, prepMin, cookMin, instructions, rows, visibility, category, tags, languageOverride, onUserEdit]);

  // Row layout tracking so we can scroll-to-first-pending on submit-block.
  const scrollRef = useRef<ScrollView>(null);
  const rowYRef = useRef<Record<number, number>>({});
  // Refs for validation-error focus + scroll. When handleSubmit rejects
  // for a missing/invalid field, we focus the input and scroll to it so
  // the user doesn't have to hunt for the offending row.
  const titleInputRef = useRef<TextInput>(null);
  const servingsInputRef = useRef<TextInput>(null);
  const titleYRef = useRef(0);
  const servingsYRef = useRef(0);
  const onRowLayout = (idx: number) => (e: LayoutChangeEvent) => {
    rowYRef.current[idx] = e.nativeEvent.layout.y;
  };
  // Capture Ingredients section header y so scroll lands above the row.
  const ingredientsSectionYRef = useRef(0);
  const onIngredientsSectionLayout = (e: LayoutChangeEvent) => {
    ingredientsSectionYRef.current = e.nativeEvent.layout.y;
  };

  // ───── Tag chip handlers ─────
  // Tags are free-form labels (vegan, quick, family-favourite, …) — stored
  // lowercase, deduped, length-capped. The user types in the inline input
  // and either presses Add, hits return, or types a comma/space to commit.
  const TAG_MAX_LEN = 24;
  const TAG_MAX_COUNT = 12;
  const commitTag = (raw: string) => {
    const cleaned = raw
      .trim()
      .replace(/^#/, '')
      .replace(/\s+/g, '-')
      .toLowerCase()
      .slice(0, TAG_MAX_LEN);
    if (!cleaned) {
      setTagDraft('');
      return;
    }
    setTags((prev) => {
      if (prev.includes(cleaned)) return prev;
      if (prev.length >= TAG_MAX_COUNT) return prev;
      return [...prev, cleaned];
    });
    setTagDraft('');
  };
  const removeTag = (t: string) => {
    setTags((prev) => prev.filter((x) => x !== t));
  };
  const handleTagChange = (text: string) => {
    // Commit-on-separator: ',' or whitespace ends the chip and starts a new
    // one. Keeps the input feeling like a chip editor without an explicit
    // "Add" button being the only path in.
    if (/[,\n]/.test(text) || (text.length > tagDraft.length && /\s$/.test(text))) {
      commitTag(text.replace(/[,\n]/g, ''));
      return;
    }
    setTagDraft(text.slice(0, TAG_MAX_LEN));
  };

  // ───── Step row handlers ─────
  // Instructions are stored as an ordered list of step strings. The UI
  // mirrors the ingredient-row pattern: a vertical stack of TextInputs
  // with a remove button per row and a dashed "+ Add step" footer.
  // Trailing-empty rows are filtered out on submit so a user who taps Add
  // but never types isn't left with a phantom step.
  const addStep = () => setInstructions((prev) => [...prev, '']);
  const updateStep = (idx: number, text: string) =>
    setInstructions((prev) => prev.map((s, i) => (i === idx ? text : s)));
  const removeStep = (idx: number) =>
    setInstructions((prev) => prev.filter((_, i) => i !== idx));

  const pendingCount = useMemo(
    () => rows.filter((r) => r.pending).length,
    [rows],
  );
  const matchedCount = rows.length - pendingCount;

  const openPickerForAdd = () => {
    setPickerTarget(null);
    setPickerInitialQuery(undefined);
    setPickerOpen(true);
  };

  const openPickerForPending = (idx: number) => {
    const row = rows[idx];
    setPickerTarget(idx);
    setPickerInitialQuery(row.pending?.searchName ?? '');
    setPickerOpen(true);
  };

  const updateRow = (idx: number, patch: Partial<IngredientRow>) => {
    setRows((prev) => prev.map((r, i) => (i === idx ? { ...r, ...patch } : r)));
  };

  const removeRow = (idx: number) => {
    setRows((prev) => prev.filter((_, i) => i !== idx));
  };

  const removeAllPending = () => {
    if (pendingCount === 0) return;
    Alert.alert(
      t('ingredients.removeAllAlert.title'),
      t('ingredients.removeAllAlert.body', { count: pendingCount }),
      [
        { text: tCommon('cancel'), style: 'cancel' },
        {
          text: t('ingredients.removeAllAlert.confirm'),
          style: 'destructive',
          onPress: () => setRows((prev) => prev.filter((r) => !r.pending)),
        },
      ],
    );
  };

  const scrollToFirstPending = () => {
    const firstPendingIdx = rows.findIndex((r) => r.pending);
    if (firstPendingIdx < 0) return;
    const y = rowYRef.current[firstPendingIdx];
    if (y == null) return;
    scrollRef.current?.scrollTo({
      y: Math.max(0, ingredientsSectionYRef.current + y - 16),
      animated: true,
    });
  };

  const handleSubmit = async () => {
    if (!title.trim()) {
      Alert.alert(t('validation.missingTitleTitle'), t('validation.missingTitleBody'), [
        {
          text: tCommon('ok'),
          onPress: () => {
            // Scroll to title position then focus — order matters so the
            // keyboard doesn't pop before the field is in view.
            scrollRef.current?.scrollTo({
              y: Math.max(0, titleYRef.current - 16),
              animated: true,
            });
            // Small delay so the scroll completes before focus fires.
            setTimeout(() => titleInputRef.current?.focus(), 300);
          },
        },
      ]);
      return;
    }
    const servingsNum = parseInt(servings, 10);
    if (!servingsNum || servingsNum < 1) {
      Alert.alert(t('validation.invalidServingsTitle'), t('validation.invalidServingsBody'), [
        {
          text: tCommon('ok'),
          onPress: () => {
            scrollRef.current?.scrollTo({
              y: Math.max(0, servingsYRef.current - 16),
              animated: true,
            });
            setTimeout(() => servingsInputRef.current?.focus(), 300);
          },
        },
      ]);
      return;
    }

    if (pendingCount > 0) {
      Alert.alert(
        t('ingredients.pendingValidationAlert.title', { count: pendingCount }),
        t('ingredients.pendingValidationAlert.body'),
        [
          {
            text: tCommon('ok'),
            onPress: scrollToFirstPending,
          },
        ],
      );
      return;
    }

    for (const r of rows) {
      const q = parseFloat(r.qty);
      if (!(q >= 0) || Number.isNaN(q)) {
        Alert.alert(
          t('validation.invalidQtyTitle'),
          t('validation.invalidQtyBody', { name: r.ingredient_name }),
        );
        return;
      }
    }
    // Fold any unsubmitted tag chip into the array on submit, so a user
    // who typed a tag but forgot to press the add-button doesn't lose it.
    const pendingTag = tagDraft.trim().replace(/^#/, '');
    const finalTags = pendingTag && !tags.includes(pendingTag)
      ? [...tags, pendingTag]
      : tags;

    // Filter out blank step rows on submit — a user can add a row and
    // leave it empty (e.g. while planning); we don't want those empty
    // entries persisted as instructions.
    const finalInstructions = instructions
      .map((s) => s.trim())
      .filter((s) => s.length > 0);

    await onSubmit({
      title: title.trim(),
      description: description.trim() || null,
      servings: servingsNum,
      prep_min: prepMin ? parseInt(prepMin, 10) : null,
      cook_min: cookMin ? parseInt(cookMin, 10) : null,
      instructions: finalInstructions,
      // Guests can't publish, and users without a display name can't either
      // (anonymous public attribution removes the accountability hook). Force
      // private if either condition holds — defense against a stale `initial`
      // visibility carrying public from a re-import or a name-wipe.
      visibility: isGuest || !hasDisplayName ? 'private' : visibility,
      category,
      tags: finalTags,
      // Pass through the override when set; otherwise undefined so the
      // mutation auto-detects from title+description via the CJK
      // heuristic (see lib/queries/recipes.ts).
      language: languageOverride ?? undefined,
      ingredients: rows.map((r, i) => ({
        ingredient_id: r.ingredient_id,
        qty: parseFloat(r.qty),
        unit: r.unit,
        notes: r.notes.trim() || null,
        sort_order: i,
      })),
    });
    // Submit succeeded — wipe the draft so the next form open starts
    // clean. If onSubmit threw, we don't reach this line and the draft
    // stays so the user can retry without re-typing.
    if (draftKey) await clearRecipeDraft(draftKey);
  };

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      style={{ flex: 1 }}
    >
      <ScrollView
        ref={scrollRef}
        contentContainerStyle={{ padding: 16, paddingBottom: 48 }}
        keyboardShouldPersistTaps="handled"
      >
        {header}

        {draftRestoredAt != null && (
          <View className="mb-5 rounded-lg border border-amber-300 bg-amber-50 p-3">
            <Text className="mb-1 text-[10px] uppercase tracking-[2px] text-amber-700">
              {t('draft.restoredLabel')}
            </Text>
            <Text className="mb-2 text-sm text-gray-700">
              {t('draft.restoredBody', { age: formatDraftAge(draftRestoredAt) })}
            </Text>
            <Pressable onPress={handleDiscardDraft} hitSlop={6}>
              <Text className="text-[11px] uppercase tracking-[2px] text-red-600">
                {t('draft.discardLink')}
              </Text>
            </Pressable>
          </View>
        )}

        <View
          className="mb-2 flex-row items-baseline gap-2"
          onLayout={(e) => {
            titleYRef.current = e.nativeEvent.layout.y;
          }}
        >
          <Text className="text-[11px] uppercase tracking-[2px] text-gray-500">
            {t('title.label')}
          </Text>
          <Text className="text-[10px] uppercase tracking-[2px] text-terracotta-600">
            {t('title.requiredHint')}
          </Text>
        </View>
        <TextInput
          ref={titleInputRef}
          className="mb-5 rounded-lg border border-gray-300 px-4 py-3 text-base"
          placeholder={t('title.placeholder')}
          value={title}
          onChangeText={setTitle}
        />

        <Text className="mb-2 text-[11px] uppercase tracking-[2px] text-gray-500">
          {t('description.label')}
        </Text>
        <TextInput
          className="mb-5 rounded-lg border border-gray-300 px-4 py-3 text-base"
          placeholder={t('description.placeholder')}
          multiline
          value={description}
          onChangeText={setDescription}
        />

        {/* Category — curated chip selector (Breakfast / Lunch / Dinner /
            Snack / Dessert / Drink). Optional: tap the active chip again to
            clear. Drives the library filter, the Discover filter, and the
            badge on the recipe detail screen. */}
        <Text className="mb-2 text-[11px] uppercase tracking-[2px] text-gray-500">
          {t('category.label')}
        </Text>
        <View className="mb-5 flex-row flex-wrap gap-2">
          {RECIPE_CATEGORIES.map((c) => {
            const active = category === c;
            return (
              <Pressable
                key={c}
                onPress={() => setCategory(active ? null : c)}
                className={`rounded-full border px-3 py-1.5 ${
                  active ? 'border-black bg-black' : 'border-gray-300 bg-white'
                }`}
              >
                <Text
                  className={`text-[11px] uppercase tracking-[2px] ${
                    active ? 'text-white' : 'text-gray-700'
                  }`}
                >
                  {c}
                </Text>
              </Pressable>
            );
          })}
        </View>

        {/* Language override chip — surfaces ONLY when the effective
            recipe language (override OR detected) differs from the user's
            UI language. Most monolingual users never see this; it appears
            for cross-lingual cases (Chinese UI + typing an English
            recipe, or vice versa) so they can confirm or override the
            auto-detected language. Tap the active chip to clear back to
            auto-detect. */}
        {(() => {
          const detected = detectRecipeLanguage(title, description);
          const effective = languageOverride ?? detected ?? uiLanguage;
          if (effective === uiLanguage) return null;
          return (
            <>
              <View className="mb-2 flex-row items-baseline justify-between">
                <Text className="text-[11px] uppercase tracking-[2px] text-gray-500">
                  {t('language.label')}
                </Text>
                <Text className="text-[10px] uppercase tracking-[2px] text-gray-400">
                  {t('language.hint')}
                </Text>
              </View>
              <View className="mb-5 flex-row gap-2">
                {(['en', 'zh-Hans'] as const).map((lang) => {
                  const active = effective === lang;
                  return (
                    <Pressable
                      key={lang}
                      onPress={() =>
                        setLanguageOverride(active ? null : lang)
                      }
                      className={`rounded-full border px-3 py-1.5 ${
                        active ? 'border-black bg-black' : 'border-gray-300 bg-white'
                      }`}
                    >
                      <Text
                        className={`text-[11px] uppercase tracking-[2px] ${
                          active ? 'text-white' : 'text-gray-700'
                        }`}
                      >
                        {RECIPE_LANGUAGE_LABEL[lang]}
                      </Text>
                    </Pressable>
                  );
                })}
              </View>
            </>
          );
        })()}

        {/* Tags — free-form chip input. Lowercase, deduped, capped at 12
            tags × 24 chars each. Commits on comma, return, or tap-to-add. */}
        <View className="mb-2 flex-row items-baseline justify-between">
          <Text className="text-[11px] uppercase tracking-[2px] text-gray-500">
            {t('tags.label')}
          </Text>
          <Text className="text-[10px] uppercase tracking-[2px] text-gray-400">
            {t('tags.counter', { count: tags.length, max: TAG_MAX_COUNT })}
          </Text>
        </View>
        {tags.length > 0 && (
          <View className="mb-2 flex-row flex-wrap gap-2">
            {tags.map((t) => (
              <Pressable
                key={t}
                onPress={() => removeTag(t)}
                className="flex-row items-center gap-1.5 rounded-full border border-gray-300 bg-gray-50 px-3 py-1.5"
              >
                <Text className="text-[11px] text-gray-700">#{t}</Text>
                <Text className="text-[11px] text-gray-400">×</Text>
              </Pressable>
            ))}
          </View>
        )}
        <View className="mb-5 flex-row gap-2">
          <TextInput
            className="flex-1 rounded-lg border border-gray-300 px-4 py-2.5 text-base"
            placeholder={t('tags.placeholder')}
            autoCapitalize="none"
            autoCorrect={false}
            value={tagDraft}
            onChangeText={handleTagChange}
            onSubmitEditing={() => commitTag(tagDraft)}
            returnKeyType="done"
            editable={tags.length < TAG_MAX_COUNT}
          />
          <Pressable
            onPress={() => commitTag(tagDraft)}
            disabled={!tagDraft.trim() || tags.length >= TAG_MAX_COUNT}
            className={`items-center justify-center rounded-lg border px-3 ${
              tagDraft.trim() && tags.length < TAG_MAX_COUNT
                ? 'border-black bg-white'
                : 'border-gray-300 bg-white'
            }`}
          >
            <Text
              className={`text-[11px] uppercase tracking-[2px] ${
                tagDraft.trim() && tags.length < TAG_MAX_COUNT
                  ? 'text-black'
                  : 'text-gray-400'
              }`}
            >
              {t('tags.addButton')}
            </Text>
          </Pressable>
        </View>

        {/* Visibility — moved up from below Instructions so users see the
            publish choice BEFORE investing minutes typing ingredients and
            steps. Guests + users without display names see a locked
            "Private" chip with a redirect to the prerequisite screen. */}
        <Text className="mb-2 text-[11px] uppercase tracking-[2px] text-gray-500">
          {t('visibility.label')}
        </Text>
        {isGuest ? (
          <>
            <View className="mb-2 flex-row gap-2">
              <View className="flex-row items-center gap-1.5 rounded-full border border-gray-200 bg-gray-50 px-3 py-1.5">
                <Text className="text-[11px] text-gray-400">🔒</Text>
                <Text className="text-[11px] uppercase tracking-[2px] text-gray-600">
                  {t('visibility.private')}
                </Text>
              </View>
            </View>
            <Pressable
              onPress={() => router.push('/sign-in' as any)}
              hitSlop={6}
              className="mb-6 self-start"
            >
              <Text className="text-[10px] uppercase tracking-[2px] text-gray-700 underline">
                {t('visibility.guestLockedLink')}
              </Text>
            </Pressable>
          </>
        ) : !hasDisplayName ? (
          <>
            <View className="mb-2 flex-row gap-2">
              <View className="flex-row items-center gap-1.5 rounded-full border border-gray-200 bg-gray-50 px-3 py-1.5">
                <Text className="text-[11px] text-gray-400">🔒</Text>
                <Text className="text-[11px] uppercase tracking-[2px] text-gray-600">
                  {t('visibility.private')}
                </Text>
              </View>
            </View>
            <Pressable
              onPress={() => router.push('/settings' as any)}
              hitSlop={6}
              className="mb-6 self-start"
            >
              <Text className="text-[10px] uppercase tracking-[2px] text-gray-700 underline">
                {t('visibility.noNameLockedLink')}
              </Text>
            </Pressable>
          </>
        ) : (
          <>
            <View className="mb-2 flex-row gap-2">
              {(['private', 'public'] as const).map((v) => {
                const active = visibility === v;
                return (
                  <Pressable
                    key={v}
                    onPress={() => setVisibility(v)}
                    className={`rounded-full border px-3 py-1.5 ${
                      active ? 'border-black bg-black' : 'border-gray-300 bg-white'
                    }`}
                  >
                    <Text
                      className={`text-[11px] uppercase tracking-[2px] ${active ? 'text-white' : 'text-gray-700'}`}
                    >
                      {v === 'private' ? t('visibility.private') : t('visibility.public')}
                    </Text>
                  </Pressable>
                );
              })}
            </View>
            <Text className="text-base font-serif italic text-gray-600">
              {visibility === 'public'
                ? t('visibility.publicHint')
                : t('visibility.privateHint')}
            </Text>
            {visibility === 'public' && (
              <Text className="mt-1 text-[10px] uppercase tracking-[2px] text-gray-400">
                {t('visibility.moderationHint')}
              </Text>
            )}
            {initial?.visibility === 'public' && visibility === 'private' && (
              <Text className="mt-2 font-serif italic text-sm text-amber-700">
                {t('visibility.downgradeWarning')}
              </Text>
            )}
            <View className="mb-6" />
          </>
        )}

        <View
          className="mb-6 flex-row gap-3"
          onLayout={(e) => {
            servingsYRef.current = e.nativeEvent.layout.y;
          }}
        >
          <View className="flex-1">
            <Text className="mb-2 text-[11px] uppercase tracking-[2px] text-gray-500">
              {t('servings.label')}
            </Text>
            <TextInput
              ref={servingsInputRef}
              className="rounded-lg border border-gray-300 px-4 py-3 text-base"
              keyboardType="number-pad"
              value={servings}
              onChangeText={setServings}
              inputAccessoryViewID="recipeFormDone"
            />
          </View>
          <View className="flex-1">
            <Text className="mb-2 text-[11px] uppercase tracking-[2px] text-gray-500">
              {t('prep.label')}
            </Text>
            <TextInput
              className="rounded-lg border border-gray-300 px-4 py-3 text-base"
              keyboardType="number-pad"
              value={prepMin}
              onChangeText={setPrepMin}
              inputAccessoryViewID="recipeFormDone"
            />
          </View>
          <View className="flex-1">
            <Text className="mb-2 text-[11px] uppercase tracking-[2px] text-gray-500">
              {t('cook.label')}
            </Text>
            <TextInput
              className="rounded-lg border border-gray-300 px-4 py-3 text-base"
              keyboardType="number-pad"
              value={cookMin}
              onChangeText={setCookMin}
              inputAccessoryViewID="recipeFormDone"
            />
          </View>
        </View>

        <View onLayout={onIngredientsSectionLayout}>
          <View className="mb-2 flex-row items-baseline justify-between">
            <View className="flex-row items-baseline gap-2">
              <Text className="text-[11px] uppercase tracking-[2px] text-gray-500">
                {t('ingredients.label')}
              </Text>
              <Text className="text-[10px] uppercase tracking-[2px] text-terracotta-600">
                {t('ingredients.atLeastOne')}
              </Text>
            </View>
            {rows.length > 0 && (
              <Text
                className={`text-[10px] uppercase tracking-[2px] ${pendingCount > 0 ? 'text-amber-700' : 'text-gray-400'}`}
              >
                {t('ingredients.readyCount', { matched: matchedCount })}
                {pendingCount > 0
                  ? t('ingredients.pendingCount', { pending: pendingCount })
                  : ''}
              </Text>
            )}
          </View>

          {pendingCount > 0 && (
            <Pressable
              onPress={removeAllPending}
              hitSlop={6}
              className="mb-3 self-start"
            >
              <Text className="text-[10px] uppercase tracking-[2px] text-red-600">
                {t('ingredients.removeAllPending')}
              </Text>
            </Pressable>
          )}

          {rows.map((row, idx) =>
            row.pending ? (
              <View
                key={`pending-${idx}`}
                onLayout={onRowLayout(idx)}
                className="mb-3 rounded-lg border border-amber-400 bg-amber-50 p-3"
              >
                <View className="mb-2 flex-row items-center justify-between">
                  <Text className="text-[10px] uppercase tracking-[2px] text-amber-700">
                    {t('ingredients.pending.label')}
                  </Text>
                  <Pressable onPress={() => removeRow(idx)} hitSlop={8}>
                    <Text className="text-[10px] uppercase tracking-[2px] text-red-600">
                      {t('ingredients.row.removeButton')}
                    </Text>
                  </Pressable>
                </View>
                <Text className="mb-3 font-serif text-base">{row.pending.raw}</Text>
                <Pressable
                  onPress={() => openPickerForPending(idx)}
                  className="items-center rounded-lg border border-black bg-white py-2.5"
                >
                  <Text className="text-[11px] uppercase tracking-[2px] text-black">
                    {t('ingredients.pending.pickButton')}
                  </Text>
                </Pressable>
                {(row.qty || row.unit) && (
                  <Text className="mt-2 text-[11px] uppercase tracking-[2px] text-gray-500">
                    {t('ingredients.pending.suggestedHint', {
                      qty: row.qty || '—',
                      unit: row.unit || '',
                    })}
                  </Text>
                )}
              </View>
            ) : (
              <View
                key={`${row.ingredient_id}-${idx}`}
                onLayout={onRowLayout(idx)}
                className="mb-3 rounded-lg border border-gray-200 p-3"
              >
                <View className="mb-2 flex-row items-center justify-between">
                  <Text className="flex-1 font-serif text-base">
                    {row.ingredient_name}
                  </Text>
                  <Pressable onPress={() => removeRow(idx)} hitSlop={8}>
                    <Text className="text-[10px] uppercase tracking-[2px] text-red-600">
                      {t('ingredients.row.removeButton')}
                    </Text>
                  </Pressable>
                </View>
                {row.from_import ? (
                  <Text className="mb-2 text-[10px] uppercase tracking-[2px] text-gray-400">
                    {t('ingredients.row.fromImport', { raw: row.from_import.raw })}
                  </Text>
                ) : null}
                <View className="flex-row gap-2">
                  <TextInput
                    className="flex-1 rounded-lg border border-gray-300 px-3 py-2 text-base"
                    placeholder={t('ingredients.row.qtyPlaceholder')}
                    keyboardType="decimal-pad"
                    value={row.qty}
                    onChangeText={(next) => updateRow(idx, { qty: next })}
                    inputAccessoryViewID="recipeFormDone"
                  />
                  <TextInput
                    className="w-20 rounded-lg border border-gray-300 px-3 py-2 text-base"
                    placeholder={t('ingredients.row.unitPlaceholder')}
                    autoCapitalize="none"
                    value={row.unit}
                    onChangeText={(next) => updateRow(idx, { unit: next })}
                  />
                </View>
                <TextInput
                  className="mt-2 rounded-lg border border-gray-300 px-3 py-2 text-base"
                  placeholder={t('ingredients.row.notesPlaceholder')}
                  value={row.notes}
                  onChangeText={(next) => updateRow(idx, { notes: next })}
                />
              </View>
            ),
          )}
          <Pressable
            onPress={openPickerForAdd}
            className="mb-6 items-center rounded-lg border border-dashed border-gray-400 py-3"
          >
            <Text className="text-[11px] uppercase tracking-[2px] text-gray-700">
              {t('ingredients.addButton')}
            </Text>
          </Pressable>
        </View>

        <Text className="mb-2 text-[11px] uppercase tracking-[2px] text-gray-500">
          {t('instructions.label')}
        </Text>
        {instructions.length === 0 ? (
          // Empty state — distinct from the per-row UI so the dashed
          // add-button isn't sitting alone with no context.
          <Text className="mb-3 font-serif text-base italic text-gray-500">
            {t('instructions.emptyHint')}
          </Text>
        ) : (
          instructions.map((step, idx) => (
            <View
              key={`step-${idx}`}
              className="mb-3 rounded-lg border border-gray-200 p-3"
            >
              <View className="mb-2 flex-row items-center justify-between">
                <Text className="text-[10px] uppercase tracking-[2px] text-gray-500">
                  {t('instructions.stepLabel', { n: idx + 1 })}
                </Text>
                <Pressable onPress={() => removeStep(idx)} hitSlop={8}>
                  <Text className="text-[10px] uppercase tracking-[2px] text-red-600">
                    {t('instructions.stepRemoveButton')}
                  </Text>
                </Pressable>
              </View>
              <TextInput
                className="rounded-lg border border-gray-300 px-3 py-2 text-base"
                placeholder={t('instructions.stepPlaceholder')}
                multiline
                style={{ minHeight: 64, textAlignVertical: 'top' }}
                value={step}
                onChangeText={(next) => updateStep(idx, next)}
              />
            </View>
          ))
        )}
        <Pressable
          onPress={addStep}
          className="mb-6 items-center rounded-lg border border-dashed border-gray-400 py-3"
        >
          <Text className="text-[11px] uppercase tracking-[2px] text-gray-700">
            {t('instructions.addStepButton')}
          </Text>
        </Pressable>

        <Pressable
          onPress={handleSubmit}
          disabled={submitting}
          className="items-center rounded-lg bg-black py-3"
        >
          {submitting ? (
            <ActivityIndicator color="white" />
          ) : (
            <Text className="text-base font-semibold text-white">{submitLabel}</Text>
          )}
        </Pressable>
      </ScrollView>

      <IngredientPicker
        visible={pickerOpen}
        onClose={() => setPickerOpen(false)}
        initialQuery={pickerInitialQuery}
        onSelect={(ing) => {
          if (pickerTarget != null) {
            // Resolving a pending row: keep its suggested qty/unit/notes.
            setRows((prev) =>
              prev.map((r, i) => {
                if (i !== pickerTarget) return r;
                const dupIdx = prev.findIndex(
                  (other, otherIdx) =>
                    otherIdx !== i && other.ingredient_id === ing.id,
                );
                if (dupIdx >= 0) {
                  Alert.alert(
                    t('ingredients.duplicateAlert.title'),
                    t('ingredients.duplicateAlert.body', { name: ing.name }),
                  );
                  return r;
                }
                return {
                  ingredient_id: ing.id,
                  ingredient_name: ing.name,
                  qty: r.qty,
                  unit: r.unit || ing.default_unit,
                  notes: r.notes,
                  pending: undefined,
                  // Keep the original imported line as a sticky reference so
                  // the user can adjust qty/unit while still seeing what
                  // the recipe originally said.
                  from_import: r.from_import ?? (r.pending ? { raw: r.pending.raw } : undefined),
                };
              }),
            );
            return;
          }
          if (rows.some((r) => r.ingredient_id === ing.id)) {
            Alert.alert(
              t('ingredients.duplicateAlert.title'),
              t('ingredients.duplicateAlert.body', { name: ing.name }),
            );
            return;
          }
          setRows((prev) => [
            ...prev,
            {
              ingredient_id: ing.id,
              ingredient_name: ing.name,
              qty: '',
              unit: ing.default_unit,
              notes: '',
            },
          ]);
        }}
      />

      {/* iOS: render a "Done" bar above numeric keyboards so the user can
          dismiss without tapping outside. Android handles this via the
          built-in keyboard chrome. Wired to TextInputs via
          inputAccessoryViewID="recipeFormDone". */}
      {Platform.OS === 'ios' && (
        <InputAccessoryView nativeID="recipeFormDone">
          <View className="flex-row justify-end border-t border-gray-200 bg-gray-50 px-4 py-2">
            <Pressable onPress={() => Keyboard.dismiss()} hitSlop={8}>
              <Text className="text-base font-semibold text-blue-600">
                {tCommon('done')}
              </Text>
            </Pressable>
          </View>
        </InputAccessoryView>
      )}
    </KeyboardAvoidingView>
  );
}
