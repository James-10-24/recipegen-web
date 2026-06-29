import { useQueryClient } from '@tanstack/react-query';
import * as Clipboard from 'expo-clipboard';
import { useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useTranslation } from 'react-i18next';

import { AiCapBlock, AiQuotaHint } from '@/components/ai-cap-block';
import { useAiOpStatus } from '@/lib/gates';
import { invalidateAiUsage } from '@/lib/queries/ai-usage';
import { subscriptionKeys } from '@/lib/queries/subscription';
import {
  extractRecipeFromText,
  generateRecipeFromPrompt,
  importRecipeFromUrl,
  type ImportResult,
} from '@/lib/recipe-import';

type Mode = 'url' | 'prompt' | 'text';

const MAX_PROMPT_LEN = 600;
// Server-side cap is 12_000; mirror it client-side so the textarea counter
// hits a hard limit before the API does (smoother UX than a 400 round-trip).
const MAX_TEXT_LEN = 12_000;
const MIN_TEXT_LEN = 30;

type Props = {
  /**
   * Called with the parsed candidate. Should return true if the host
   * accepted and applied it (so the banner can clear), false if the host
   * rejected it (so the input stays put and the user can retry).
   */
  onImported: (result: ImportResult) => Promise<boolean> | boolean;
  /** Default servings for AI-generated recipes (usually household_size). */
  defaultServings?: number;
};

/**
 * Detect AI output that's not usable per the Q5 lock — recipe must have
 * both ingredients and instructions to be a complete starting point. URL
 * imports sometimes return one without the other (e.g., a paywalled page
 * where parsing finds a title but nothing else); generations occasionally
 * produce malformed JSON. Either failure mode = inline error, not empty
 * review.
 */
function isResultUsable(result: ImportResult): boolean {
  // Q3: instructions are an array of step strings — a recipe is unusable
  // if every step is blank (or the array is empty). Mirror the same
  // strictness as the old prose-blob check.
  const hasInstructions =
    Array.isArray(result.instructions) &&
    result.instructions.some((s) => s && s.trim().length > 0);
  if (!hasInstructions) return false;
  if (!result.ingredients || result.ingredients.length === 0) return false;
  return true;
}

export function RecipeImportBanner({ onImported, defaultServings }: Props) {
  const qc = useQueryClient();
  const status = useAiOpStatus();
  const { t } = useTranslation('recipe-form');

  // Switch wrappers for the three mode-keyed lookups. Switch keeps
  // the typed-key augmentation honest (a dynamic interpolation like
  // t(`importBanner.modes.${mode}`) would erase autocomplete).
  const modeLabel = (m: Mode): string => {
    switch (m) {
      case 'url': return t('importBanner.modes.url');
      case 'prompt': return t('importBanner.modes.prompt');
      case 'text': return t('importBanner.modes.text');
    }
  };
  const ctaLabel = (m: Mode): string => {
    switch (m) {
      case 'url': return t('importBanner.cta.url');
      case 'prompt': return t('importBanner.cta.prompt');
      case 'text': return t('importBanner.cta.text');
    }
  };
  const partialError = (m: Mode): string => {
    switch (m) {
      case 'url': return t('importBanner.errors.urlPartial');
      case 'prompt': return t('importBanner.errors.promptPartial');
      case 'text': return t('importBanner.errors.textPartial');
    }
  };
  const failedError = (m: Mode): string => {
    switch (m) {
      case 'url': return t('importBanner.errors.urlFailed');
      case 'prompt': return t('importBanner.errors.promptFailed');
      case 'text': return t('importBanner.errors.textFailed');
    }
  };

  const [mode, setMode] = useState<Mode>('url');
  const [url, setUrl] = useState('');
  const [prompt, setPrompt] = useState('');
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Switch mode + auto-prefill from clipboard when entering text mode. The
  // explicit chip-tap is the user's consent moment for iOS 16+'s paste
  // permission prompt; if they decline, we silently leave the textarea
  // empty so they can paste manually with the system context menu.
  const switchMode = async (next: Mode) => {
    setMode(next);
    setError(null);
    if (next === 'text' && !text) {
      try {
        const clip = await Clipboard.getStringAsync();
        if (clip && clip.trim().length >= MIN_TEXT_LEN) {
          setText(clip.slice(0, MAX_TEXT_LEN));
        }
      } catch {
        // Permission denied or clipboard unavailable — no-op.
      }
    }
  };

  const canSubmit =
    !busy &&
    status.canRun &&
    (mode === 'url'
      ? /^https?:\/\/\S+/i.test(url.trim())
      : mode === 'prompt'
        ? prompt.trim().length >= 5
        : text.trim().length >= MIN_TEXT_LEN);

  const handleSubmit = async () => {
    if (!canSubmit) return;
    setBusy(true);
    setError(null);
    try {
      const res =
        mode === 'url'
          ? await importRecipeFromUrl(url.trim())
          : mode === 'prompt'
            ? await generateRecipeFromPrompt({
                description: prompt.trim(),
                servings: defaultServings,
              })
            : await extractRecipeFromText(text.trim());
      // Refresh quota mirrors before checking output — server already
      // billed the op (if it succeeded server-side); local view should
      // reflect that. The Q5 threshold check below doesn't refund the
      // op because the AI call did run; the issue is that the output is
      // unusable for OUR purposes. Server-side refund happens on actual
      // AI failures (claim_ai_op release path), surfaced via the catch.
      invalidateAiUsage(qc);
      qc.invalidateQueries({ queryKey: subscriptionKeys.quota });

      if (!isResultUsable(res)) {
        // Q5 threshold rejection — surface inline error instead of
        // routing the empty result forward to the recipe form.
        setError(partialError(mode));
        return;
      }

      const accepted = await onImported(res);
      if (accepted) {
        setUrl('');
        setPrompt('');
        setText('');
      }
    } catch {
      // Server-side claim_ai_op release fires on AI infra failure, so
      // the user's op is refunded automatically. Surface that as the
      // Q2 "didn't count" reassurance in the inline error below.
      invalidateAiUsage(qc);
      qc.invalidateQueries({ queryKey: subscriptionKeys.quota });
      setError(failedError(mode));
    } finally {
      setBusy(false);
    }
  };

  // Cap-hit state (Q3) — free-tier user with 0 ops + 0 credits. Renders
  // the editorial cap-block in place of the input form. User taps "See
  // your options →" to navigate to the paywall.
  if (status.isCapped) {
    return (
      <View className="mb-6 border-b border-gray-100 pb-6">
        <Text className="mb-3 text-[11px] uppercase tracking-[2px] text-gray-500">
          {t('importBanner.eyebrow')}
        </Text>
        <AiCapBlock surface="import" />
      </View>
    );
  }

  return (
    <View className="mb-6 border-b border-gray-100 pb-6">
      <Text className="mb-2 text-[11px] uppercase tracking-[2px] text-gray-500">
        {t('importBanner.eyebrow')}
      </Text>

      <View className="mb-4 flex-row gap-2">
        {(['url', 'prompt', 'text'] as Mode[]).map((m) => {
          const active = mode === m;
          return (
            <Pressable
              key={m}
              onPress={() => switchMode(m)}
              className={`rounded-full border px-3 py-1.5 ${
                active ? 'border-black bg-black' : 'border-gray-300 bg-white'
              }`}
            >
              <Text
                className={`text-[11px] uppercase tracking-[2px] ${active ? 'text-white' : 'text-gray-700'}`}
              >
                {modeLabel(m)}
              </Text>
            </Pressable>
          );
        })}
      </View>

      {mode === 'url' ? (
        <>
          <Text className="mb-3 font-serif text-base text-gray-900">
            {t('importBanner.url.prompt')}
          </Text>
          <TextInput
            className="mb-3 rounded-lg border border-gray-300 px-4 py-3 text-base"
            placeholder={t('importBanner.url.placeholder')}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
            value={url}
            onChangeText={(next) => {
              setUrl(next);
              if (error) setError(null);
            }}
          />
        </>
      ) : mode === 'prompt' ? (
        <>
          <Text className="mb-3 font-serif text-base text-gray-900">
            {t('importBanner.prompt.prompt')}
          </Text>
          <TextInput
            className="mb-1 rounded-lg border border-gray-300 px-4 py-3 text-base"
            placeholder={t('importBanner.prompt.placeholder')}
            multiline
            value={prompt}
            onChangeText={(next) => {
              setPrompt(next.slice(0, MAX_PROMPT_LEN));
              if (error) setError(null);
            }}
            style={{ minHeight: 80, textAlignVertical: 'top' }}
          />
          <View className="mb-3 flex-row items-center justify-between">
            <Text className="text-[10px] uppercase tracking-[2px] text-gray-400">
              {t('importBanner.countsAsOp')}
            </Text>
            <Text className="text-[10px] uppercase tracking-[2px] text-gray-400">
              {t('importBanner.counter', { length: prompt.length, max: MAX_PROMPT_LEN })}
            </Text>
          </View>
        </>
      ) : (
        <>
          <Text className="mb-3 font-serif text-base text-gray-900">
            {t('importBanner.text.prompt')}
          </Text>
          <TextInput
            className="mb-1 rounded-lg border border-gray-300 px-4 py-3 text-base"
            placeholder={t('importBanner.text.placeholder')}
            multiline
            value={text}
            onChangeText={(next) => {
              setText(next.slice(0, MAX_TEXT_LEN));
              if (error) setError(null);
            }}
            style={{ minHeight: 160, textAlignVertical: 'top' }}
          />
          <View className="mb-3 flex-row items-center justify-between">
            <Text className="text-[10px] uppercase tracking-[2px] text-gray-400">
              {t('importBanner.countsAsOp')}
            </Text>
            <Text className="text-[10px] uppercase tracking-[2px] text-gray-400">
              {t('importBanner.counter', { length: text.length, max: MAX_TEXT_LEN })}
            </Text>
          </View>
        </>
      )}

      {/* Inline error state (Q2 + Q5) — replaces the prior Alert.alert.
          Includes the "didn't count" reassurance line so the user knows
          the failed call didn't burn an op. Renders only while there's
          an error to show; clears on input change or mode switch. */}
      {error ? (
        <View className="mb-3 rounded-lg border border-amber-300 bg-amber-50 px-3 py-3">
          <Text className="font-serif text-sm leading-5 text-gray-800">
            {error}
          </Text>
          <Text className="mt-2 text-[10px] uppercase tracking-[2px] text-gray-500">
            {t('importBanner.errors.didntCount')}
          </Text>
        </View>
      ) : null}

      <View className="flex-row items-center justify-between">
        <Pressable
          onPress={handleSubmit}
          disabled={!canSubmit}
          className={`items-center rounded-full border px-5 py-2 ${
            canSubmit ? 'border-black bg-white' : 'border-gray-300 bg-white'
          }`}
        >
          {busy ? (
            <ActivityIndicator color="#000" />
          ) : (
            <Text
              className={`text-[11px] uppercase tracking-[2px] ${
                canSubmit ? 'text-black' : 'text-gray-400'
              }`}
            >
              {ctaLabel(mode)}
            </Text>
          )}
        </Pressable>
        {/* Q1: near-cap counter only. AiQuotaHint renders nothing unless
            opsLeft is 1 or 2. Pro users never see it (status.isPro short-
            circuits inside the component via opsLeft===Infinity). */}
        {!status.isPro ? <AiQuotaHint opsLeft={status.opsLeft} /> : null}
      </View>
    </View>
  );
}
