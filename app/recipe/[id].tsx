import { Image } from 'expo-image';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Animated,
  Easing,
  Linking,
  Pressable,
  ScrollView,
  Share,
  Text,
  View,
} from 'react-native';
import { useTranslation } from 'react-i18next';

import { CookSheet } from '@/components/cook-sheet';
import { ReportSheet } from '@/components/report-sheet';
import { IconSymbol } from '@/components/ui/icon-symbol';
import {
  useCookStats,
  useUndoCookRecipe,
} from '@/lib/queries/cook';
import { coverageFor, type Coverage } from '@/lib/coverage';
import { useAuth } from '@/lib/auth-context';
import {
  useAuthorName,
  useSaveRecipe,
  useSavedFromAttribution,
  useSavedSet,
} from '@/lib/queries/discover';
import { useBlockUser } from '@/lib/queries/moderation';
import { usePantryList } from '@/lib/queries/pantry';
import { useDeleteRecipe, useRecipe } from '@/lib/queries/recipes';
import { type RecipeCategory } from '@/lib/recipe-categories';

function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

function round(n: number, dp = 2) {
  const m = Math.pow(10, dp);
  return Math.round(n * m) / m;
}

export default function RecipeDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const { session } = useAuth();
  const { data, isLoading, error } = useRecipe(id);
  const pantry = usePantryList();
  const del = useDeleteRecipe();
  const save = useSaveRecipe();
  const block = useBlockUser();
  const undoCook = useUndoCookRecipe();
  const [cookOpen, setCookOpen] = useState(false);
  const [reportTarget, setReportTarget] = useState<
    | { kind: 'recipe' }
    | { kind: 'user' }
    | null
  >(null);
  const { t } = useTranslation('recipe-detail');
  const { t: tCommon } = useTranslation('common');

  // Localized chip label for a category enum value. The enum strings
  // stay English app-wide (shared with DB writes + AI prompts) — we
  // look up display labels only at render. Same pattern as recipe-list.
  const categoryLabel = (c: RecipeCategory | string): string => {
    switch (c) {
      case 'Breakfast': return t('categoryLabels.Breakfast');
      case 'Lunch': return t('categoryLabels.Lunch');
      case 'Dinner': return t('categoryLabels.Dinner');
      case 'Snack': return t('categoryLabels.Snack');
      case 'Dessert': return t('categoryLabels.Dessert');
      case 'Drink': return t('categoryLabels.Drink');
      default: return String(c);
    }
  };

  // Coverage-line text + color for the ingredient list. Inlined so
  // it can call t() while staying a single switch (same shape as the
  // previous module-level helper).
  const coverageLine = (c: Coverage, unit: string): { text: string; className: string } => {
    switch (c.state) {
      case 'covered':
        // Forest green = "this ingredient is yours". Reads as positive
        // status without the visual weight of a saturated success color.
        return {
          text: t('coverage.covered', { qty: round(c.have), unit }),
          className: 'text-forest-700',
        };
      case 'short':
        return {
          text: t('coverage.short', { qty: round(c.short ?? 0), unit }),
          className: 'text-red-600',
        };
      case 'unit-mismatch':
        return {
          text: t('coverage.unitMismatch'),
          className: 'text-amber-700',
        };
      case 'missing':
      default:
        return { text: t('coverage.missing'), className: 'text-gray-400' };
    }
  };

  // Human-friendly "last cooked" relative time. Was a lib helper but
  // only used here, so inlined to thread t() through without changing
  // the lib API. Same buckets as the original.
  const relativeCookedAt = (iso: string | null): string => {
    if (!iso) return '';
    const d = new Date(iso);
    const ms = Date.now() - d.getTime();
    const days = Math.floor(ms / 86_400_000);
    if (days < 1) return t('relTime.today');
    if (days === 1) return t('relTime.yesterday');
    if (days < 7) return t('relTime.daysAgo', { count: days });
    if (days < 30) return t('relTime.weeksAgo', { count: Math.floor(days / 7) });
    if (days < 365) return t('relTime.monthsAgo', { count: Math.floor(days / 30) });
    return t('relTime.yearsAgo', { count: Math.floor(days / 365) });
  };

  // ─── Save-success editorial toast ─────────────────────────────────────
  // Replaces the previous Alert.alert which broke the editorial aesthetic
  // (system modal vs. the inline serif/small-caps language used elsewhere).
  // Matches the pattern from app/(tabs)/pantry.tsx: slide-up + fade from
  // below, auto-dismiss after 4s, "View" action mirrors the old Alert's
  // primary button so users keep the same affordance.
  const [savedToast, setSavedToast] = useState<{ newId: string } | null>(null);
  const savedOpacity = useRef(new Animated.Value(0)).current;
  const savedTranslate = useRef(new Animated.Value(24)).current;
  const savedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (savedToast) {
      Animated.parallel([
        Animated.timing(savedOpacity, {
          toValue: 1,
          duration: 180,
          easing: Easing.out(Easing.quad),
          useNativeDriver: true,
        }),
        Animated.timing(savedTranslate, {
          toValue: 0,
          duration: 180,
          easing: Easing.out(Easing.quad),
          useNativeDriver: true,
        }),
      ]).start();
      if (savedTimerRef.current) clearTimeout(savedTimerRef.current);
      savedTimerRef.current = setTimeout(() => setSavedToast(null), 4000);
    } else {
      Animated.parallel([
        Animated.timing(savedOpacity, {
          toValue: 0,
          duration: 160,
          useNativeDriver: true,
        }),
        Animated.timing(savedTranslate, {
          toValue: 24,
          duration: 160,
          useNativeDriver: true,
        }),
      ]).start();
    }
    return () => {
      if (savedTimerRef.current) {
        clearTimeout(savedTimerRef.current);
        savedTimerRef.current = null;
      }
    };
  }, [savedToast, savedOpacity, savedTranslate]);

  // ─── Cook-undo editorial toast (Q11, 10s window) ──────────────────────
  // Cook commit lands → cook-sheet closes → this toast slides up with the
  // recipe name + an Undo action. 10s window before auto-dismiss; tapping
  // Undo restores pantry deductions + deletes the cook_log row server-side
  // via useUndoCookRecipe. Lives on the parent screen (not the cook-sheet
  // which has already closed) per the Q11 lock — no global toast root,
  // so navigating away from this screen drops the undo opportunity from
  // the UI (server still permits undo via API for stragglers).
  const [cookToast, setCookToast] = useState<{
    cookLogId: string;
    recipeTitle: string;
  } | null>(null);
  const cookOpacity = useRef(new Animated.Value(0)).current;
  const cookTranslate = useRef(new Animated.Value(24)).current;
  const cookTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (cookToast) {
      Animated.parallel([
        Animated.timing(cookOpacity, {
          toValue: 1,
          duration: 180,
          easing: Easing.out(Easing.quad),
          useNativeDriver: true,
        }),
        Animated.timing(cookTranslate, {
          toValue: 0,
          duration: 180,
          easing: Easing.out(Easing.quad),
          useNativeDriver: true,
        }),
      ]).start();
      if (cookTimerRef.current) clearTimeout(cookTimerRef.current);
      // 10s window — long enough to realize "wait, wrong recipe" or
      // "I cooked half-batch not full," short enough that it doesn't
      // linger after the user has moved on.
      cookTimerRef.current = setTimeout(() => setCookToast(null), 10_000);
    } else {
      Animated.parallel([
        Animated.timing(cookOpacity, {
          toValue: 0,
          duration: 160,
          useNativeDriver: true,
        }),
        Animated.timing(cookTranslate, {
          toValue: 24,
          duration: 160,
          useNativeDriver: true,
        }),
      ]).start();
    }
    return () => {
      if (cookTimerRef.current) {
        clearTimeout(cookTimerRef.current);
        cookTimerRef.current = null;
      }
    };
  }, [cookToast, cookOpacity, cookTranslate]);

  const handleUndoCook = async () => {
    if (!cookToast) return;
    const id = cookToast.cookLogId;
    setCookToast(null);
    try {
      await undoCook.mutateAsync(id);
    } catch (e: any) {
      Alert.alert(t('alerts.undoFailedTitle'), e?.message ?? t('alerts.unknownError'));
    }
  };

  const myUserId = session?.user?.id;
  const isOwner = !!data && !!myUserId && data.user_id === myUserId;
  const authorName = useAuthorName(!isOwner ? data?.user_id : undefined);
  // Owner-mode: if this recipe is a clone, show "Saved from @author".
  // For non-owners we already show "By <author>", so skip.
  const savedFrom = useSavedFromAttribution(
    isOwner ? data?.saved_from_id ?? null : null,
  );
  // For non-owners viewing a public recipe: have they already cloned this?
  // If so, swap the CTA to "Open my saved copy" instead of letting them
  // re-tap Save (which dedupes server-side but reads as a fresh action).
  const sourceIdsForSavedCheck =
    !isOwner && data?.id ? [data.id] : ([] as string[]);
  const savedSet = useSavedSet(sourceIdsForSavedCheck);
  const existingCloneId = data ? savedSet.data?.get(data.id) : undefined;

  // Cook stats — drives the "Cooked N times · last X ago" metadata line.
  // Owner-only; non-owners don't see another user's cook history.
  const cookStats = useCookStats(isOwner ? data?.id : undefined);

  const handleDelete = () => {
    Alert.alert(t('alerts.deleteTitle'), t('alerts.deleteBody'), [
      { text: tCommon('cancel'), style: 'cancel' },
      {
        text: t('alerts.deleteConfirm'),
        style: 'destructive',
        onPress: async () => {
          try {
            await del.mutateAsync(id!);
            router.back();
          } catch (e: any) {
            Alert.alert(t('alerts.deleteFailedTitle'), e.message ?? t('alerts.unknownError'));
          }
        },
      },
    ]);
  };

  const handleSave = async () => {
    if (!data) return;
    try {
      const newId = await save.mutateAsync(data.id);
      // Inline editorial toast instead of Alert.alert — keeps the user on
      // the public detail with a "View" link to the new clone.
      setSavedToast({ newId });
    } catch (e: any) {
      Alert.alert(t('alerts.saveFailedTitle'), e.message ?? t('alerts.unknownError'));
    }
  };

  /**
   * Recipe-sharing flow (per recipe-sharing grill Q1):
   *
   * Build a clean text payload — title, meta line, ingredients,
   * instructions, photo URL on its own line — and hand it to the iOS
   * Share sheet via React Native's built-in Share API. No URL to the
   * app, no Universal Links, no brand-attribution footer. Matches the
   * "no engagement loops" brand voice: utility-only, no install-driver
   * tracking.
   *
   * Available to BOTH owner and non-owner viewing (anyone-can-share per
   * the grill). Non-owner can only see public recipes anyway (RLS), so
   * they're forwarding content the original author chose to publish.
   * Owner can share even private recipes — they're sharing their own
   * content; private just means "not in Discover," not "not shareable."
   */
  const handleShare = async () => {
    if (!data) return;
    const lines: string[] = [];
    lines.push(data.title);

    const meta: string[] = [t('share.serves', { count: data.servings })];
    if (data.prep_min != null) meta.push(t('share.prepMin', { min: data.prep_min }));
    if (data.cook_min != null) meta.push(t('share.cookMin', { min: data.cook_min }));
    lines.push(meta.join(' · '));
    lines.push('');

    if (data.ingredients.length > 0) {
      lines.push(t('share.ingredientsHeading'));
      for (const ing of data.ingredients) {
        // Qty rendered as bare number when unit is the abstract "pcs"
        // (else "2 pcs flour" reads weirdly); otherwise "2 cups flour."
        const qtyDisplay =
          ing.qty > 0
            ? ing.unit && ing.unit !== 'pcs'
              ? `${ing.qty} ${ing.unit} `
              : `${ing.qty} `
            : '';
        const noteSuffix = ing.notes ? ` — ${ing.notes}` : '';
        lines.push(`· ${qtyDisplay}${ing.ingredient_name}${noteSuffix}`);
      }
      lines.push('');
    }

    if (data.instructions && data.instructions.length > 0) {
      lines.push(t('share.instructionsHeading'));
      // Numbered prose for the share payload — receiver-friendly in
      // WhatsApp/Messages/Mail. Blank steps shouldn't ever ship from the
      // form (filter on submit) but trim defensively in case of stragglers.
      let n = 1;
      for (const step of data.instructions) {
        const trimmed = step.trim();
        if (!trimmed) continue;
        lines.push(`${n}. ${trimmed}`);
        n++;
      }
      lines.push('');
    }

    // Photo URL on its own line — WhatsApp / Messages / Mail render this
    // as a tappable link or rich preview. Cheaper than multi-payload
    // native sharing (which would need an image attachment alongside
    // text and varies in cross-app reliability).
    if (data.photo_url) {
      lines.push(data.photo_url);
    }

    const message = lines.join('\n').trim();

    try {
      await Share.share({ message });
    } catch {
      // User cancelled the Share sheet, or a system-level dismiss
      // fired. Silent ignore — no error state to surface.
    }
  };

  const handleBlock = () => {
    if (!data) return;
    const name = authorName.data ?? t('alerts.thisUserFallback');
    Alert.alert(
      t('alerts.blockTitle', { name }),
      t('alerts.blockBody'),
      [
        { text: tCommon('cancel'), style: 'cancel' },
        {
          text: t('alerts.blockConfirm'),
          style: 'destructive',
          onPress: async () => {
            try {
              await block.mutateAsync(data.user_id);
              // Brief Alert confirms the block landed before navigating
              // back — the recipe-detail screen unmounts on router.back()
              // so an inline toast on this surface wouldn't be visible.
              // Alert is acceptable here as an informational bridge.
              Alert.alert(
                t('alerts.blockedTitle', { name }),
                t('alerts.blockedBody'),
                [{ text: tCommon('ok'), onPress: () => router.back() }],
              );
            } catch (e: any) {
              Alert.alert(t('alerts.blockFailedTitle'), e.message ?? t('alerts.unknownError'));
            }
          },
        },
      ],
    );
  };

  const openMoreActions = () => {
    if (!data) return;
    Alert.alert(t('alerts.moreActionsTitle'), undefined, [
      {
        text: t('alerts.moreReportRecipe'),
        onPress: () => setReportTarget({ kind: 'recipe' }),
      },
      {
        text: t('alerts.moreReportAuthor'),
        onPress: () => setReportTarget({ kind: 'user' }),
      },
      { text: t('alerts.moreBlockAuthor'), style: 'destructive', onPress: handleBlock },
      { text: tCommon('cancel'), style: 'cancel' },
    ]);
  };

  if (isLoading) {
    return (
      <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center' }}>
        <ActivityIndicator />
      </View>
    );
  }

  if (error || !data) {
    return (
      <View className="flex-1 items-center justify-center px-6">
        <Text className="text-center text-red-600">
          {(error as Error | undefined)?.message ?? t('error.notFound')}
        </Text>
      </View>
    );
  }

  const pantryItems = pantry.data ?? [];

  return (
    <>
      <Stack.Screen
        options={{
          title: data.title,
          headerRight: () => (
            // hitSlop 12 brings text-base touch zones to ≥44pt vertically,
            // matching Apple HIG. Share + Edit/⋯ in a flex-row with gap-4
            // so both header actions remain reachable without crowding.
            //
            // Share button visible to BOTH owner and non-owner per the
            // recipe-sharing grill Q1 (anyone-can-share). Calls the
            // handleShare which formats clean text + photo URL into
            // React Native's Share sheet.
            <View className="flex-row items-center gap-4">
              <Pressable
                onPress={handleShare}
                hitSlop={12}
                accessibilityLabel={t('header.shareA11y')}
              >
                <Text className="text-base text-blue-600">{t('header.share')}</Text>
              </Pressable>
              {isOwner ? (
                <Pressable
                  onPress={() => router.push(`/recipe/edit/${data.id}` as any)}
                  hitSlop={12}
                >
                  <Text className="text-base text-blue-600">{t('header.edit')}</Text>
                </Pressable>
              ) : (
                <Pressable
                  onPress={openMoreActions}
                  hitSlop={12}
                  accessibilityLabel={t('header.moreActionsA11y')}
                >
                  {/* SF Symbols / Material vector — replaces the bare U+22EF
                      glyph which renders inconsistently across iOS versions
                      and on Android (the same posture we already enforce
                      against emoji icons elsewhere). */}
                  <IconSymbol name="ellipsis" size={22} color="#374151" />
                </Pressable>
              )}
            </View>
          ),
        }}
      />
      <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 48 }}>
        {data.photo_url ? (
          <View className="mb-4 overflow-hidden rounded-lg border border-gray-100">
            <Image
              source={{ uri: data.photo_url }}
              style={{ width: '100%', aspectRatio: 16 / 9 }}
              contentFit="cover"
              transition={200}
            />
          </View>
        ) : null}
        <Text className="font-serif-bold text-3xl">{data.title}</Text>
        {data.description && (
          <Text className="mt-1 text-base text-gray-600">{data.description}</Text>
        )}
        {/* Curated category badge + language chip — small-caps pills in
            the same row, matching the rest of the editorial chrome. Each
            renders only when set; legacy rows (pre-Q2 / pre-localization)
            simply omit. */}
        {(data.category || data.language) ? (
          <View className="mt-2 flex-row flex-wrap gap-1.5">
            {data.category ? (
              <View className="rounded-full border border-terracotta-300 bg-cream-50 px-3 py-1">
                <Text className="text-[10px] uppercase tracking-[2px] text-terracotta-700">
                  {categoryLabel(data.category)}
                </Text>
              </View>
            ) : null}
            {data.language ? (
              <View className="rounded-full border border-gray-300 bg-white px-3 py-1">
                <Text className="text-[10px] uppercase tracking-[2px] text-gray-600">
                  {data.language === 'zh-Hans' ? '中文' : 'English'}
                </Text>
              </View>
            ) : null}
          </View>
        ) : null}
        <Text className="mt-2 text-sm text-gray-500">
          {t('meta.servings', { count: data.servings })}
          {data.prep_min != null ? ` · ${t('meta.prepMin', { min: data.prep_min })}` : ''}
          {data.cook_min != null ? ` · ${t('meta.cookMin', { min: data.cook_min })}` : ''}
        </Text>
        {data.tags && data.tags.length > 0 ? (
          <View className="mt-2 flex-row flex-wrap gap-1.5">
            {/* Tags render verbatim — they're user-supplied free-text and
                stay in whatever language the recipe was authored in. */}
            {data.tags.map((tag) => (
              <View
                key={tag}
                className="rounded-full border border-gray-200 bg-gray-50 px-2.5 py-0.5"
              >
                <Text className="text-[11px] text-gray-600">#{tag}</Text>
              </View>
            ))}
          </View>
        ) : null}
        {isOwner &&
        cookStats.data &&
        cookStats.data.cookedCount > 0 ? (
          // "Cooked N times" — owner-only, hidden when count = 0.
          // Terracotta tint signals it's an earned-history line, not
          // chrome. Stale (>90d) cooks render gray as a quiet "haven't
          // made this in a while" cue without nagging.
          <Text
            className={`mt-1 text-xs ${
              cookStats.data.lastCookedAt &&
              Date.now() - new Date(cookStats.data.lastCookedAt).getTime() >
                90 * 86_400_000
                ? 'text-gray-400'
                : 'text-terracotta-600'
            }`}
          >
            {cookStats.data.cookedCount === 1
              ? t('cookStats.cookedOnce')
              : t('cookStats.cookedTimes', { count: cookStats.data.cookedCount })}
            {cookStats.data.lastCookedAt
              ? t('cookStats.lastSuffix', {
                  when: relativeCookedAt(cookStats.data.lastCookedAt),
                })
              : ''}
          </Text>
        ) : null}
        {!isOwner && authorName.data ? (
          // Sibling-Text layout (not nested) so Android letterSpacing
          // inheritance from the small-caps parent doesn't bleed into
          // the italic name. Editorial byline: tracked "BY" + italic
          // terracotta name.
          <View className="mt-2 flex-row flex-wrap items-baseline">
            <Text className="text-[11px] uppercase tracking-[2px] text-gray-500">
              {t('byline.by')}
            </Text>
            <Text className="ml-1.5 font-serif text-base italic text-terracotta-600">
              {authorName.data}
            </Text>
          </View>
        ) : null}
        {isOwner && data.saved_from_id ? (
          // Prefer the live RLS-gated lookup (current source title, current
          // author name) so renames flow through. If the source has gone
          // private or its author deleted their account, fall back to the
          // denormalized author snapshot taken at save time so attribution
          // doesn't silently vanish.
          <View className="mt-2 flex-row flex-wrap items-baseline">
            <Text className="text-[11px] uppercase tracking-[2px] text-gray-500">
              {t('byline.savedFrom')}
            </Text>
            {savedFrom.data ? (
              <Text className="ml-1.5 font-serif text-base italic text-terracotta-600">
                {savedFrom.data.title}
              </Text>
            ) : (
              <Text className="ml-1.5 font-serif text-base italic text-gray-500">
                {t('byline.privateRecipeFallback')}
              </Text>
            )}
            {(savedFrom.data?.author_name ?? data.saved_from_author_name) ? (
              <>
                <Text className="ml-1.5 text-[11px] uppercase tracking-[2px] text-gray-500">
                  {t('byline.byAuthor')}
                </Text>
                <Text className="ml-1.5 font-serif text-base italic text-terracotta-600">
                  {savedFrom.data?.author_name ?? data.saved_from_author_name}
                </Text>
              </>
            ) : null}
          </View>
        ) : null}
        {data.source_url ? (
          <Pressable
            onPress={() => Linking.openURL(data.source_url!).catch(() => {})}
            hitSlop={6}
            className="mt-2 self-start"
          >
            <Text className="text-[11px] uppercase tracking-[2px] text-gray-500">
              {t('byline.sourceLink', { host: hostnameOf(data.source_url) })}
            </Text>
          </Pressable>
        ) : null}
        {isOwner ? (
          data.visibility === 'public' && data.moderation_status === 'approved' ? (
            <Text className="mt-2 text-[10px] uppercase tracking-[2px] text-gray-500">
              {t('owner.publicVisible')}
            </Text>
          ) : data.moderation_status === 'rejected' ? (
            // Reviewer rejected the publish. We force-private on rejection
            // so the row is safe to show and edit; the user can revise and
            // re-toggle public to retry moderation. Category chips help the
            // user understand WHAT was flagged so they can self-correct
            // ("hate" vs "violence" vs "sexual" all need different edits).
            <View className="mt-2">
              <Text className="text-[10px] uppercase tracking-[2px] text-red-600">
                {t('owner.publishRefused')}
              </Text>
              {data.moderation_categories && data.moderation_categories.length > 0 ? (
                <View className="mt-1.5 flex-row flex-wrap gap-1.5">
                  {data.moderation_categories.map((c) => (
                    <View
                      key={c}
                      className="rounded-full border border-red-300 bg-red-50 px-2 py-0.5"
                    >
                      <Text className="text-[10px] uppercase tracking-[1.5px] text-red-600">
                        {/* OpenAI returns slugs like "hate/threatening" or
                            "self-harm/instructions" — swap "/" for " · " so
                            the chip reads as small-caps editorial copy. */}
                        {c.replace('/', ' · ')}
                      </Text>
                    </View>
                  ))}
                </View>
              ) : null}
            </View>
          ) : null
        ) : null}

        {isOwner ? (
          <Pressable
            onPress={() => setCookOpen(true)}
            className="mt-5 items-center rounded-lg bg-black py-3"
          >
            <Text className="text-base font-semibold text-white">{t('cta.iCookedThis')}</Text>
          </Pressable>
        ) : existingCloneId ? (
          // Already saved — open the user's clone instead of re-tapping
          // Save. The server dedupes, but a no-op confirmation reads as a
          // bug. The hairline-bordered treatment marks this as a "you've
          // already done this" affordance vs. the solid black CTA.
          <Pressable
            onPress={() => router.push(`/recipe/${existingCloneId}` as any)}
            className="mt-5 items-center rounded-lg border border-black bg-white py-3"
          >
            <Text className="text-base font-semibold text-black">
              {t('cta.openSavedCopy')}
            </Text>
          </Pressable>
        ) : (
          <Pressable
            onPress={handleSave}
            disabled={save.isPending}
            className="mt-5 items-center rounded-lg bg-black py-3"
          >
            {save.isPending ? (
              <ActivityIndicator color="white" />
            ) : (
              <Text className="text-base font-semibold text-white">
                {t('cta.saveToMine')}
              </Text>
            )}
          </Pressable>
        )}

        <Text className="mb-3 mt-6 text-[11px] uppercase tracking-[2px] text-gray-500">
          {t('sections.ingredients')}
        </Text>
        {data.ingredients.length === 0 ? (
          // Editorial empty state matching the brand voice across the
          // app — was a plain text-gray-500 break in an otherwise
          // typography-careful screen.
          <Text className="font-serif text-base italic text-gray-500">
            {t('sections.emptyIngredients')}
          </Text>
        ) : (
          data.ingredients.map((i) => {
            const c = coverageFor(
              i.ingredient_id,
              i.qty,
              i.unit,
              i.density_g_per_ml,
              pantryItems,
            );
            const line = coverageLine(c, i.unit);
            return (
              <View key={`${i.ingredient_id}-${i.sort_order}`} className="mb-3">
                <View className="flex-row">
                  <Text
                    className="w-24 text-base text-gray-700"
                    style={{ fontVariant: ['tabular-nums'] }}
                  >
                    {i.qty} {i.unit}
                  </Text>
                  <Text className="flex-1 font-serif text-base">
                    {i.ingredient_name}
                    {i.notes ? (
                      <Text className="text-gray-500"> — {i.notes}</Text>
                    ) : null}
                  </Text>
                </View>
                {isOwner ? (
                  <Text className={`ml-24 mt-0.5 text-xs ${line.className}`}>
                    {line.text}
                  </Text>
                ) : null}
              </View>
            );
          })
        )}

        {data.instructions && data.instructions.length > 0 && (
          <>
            <Text className="mb-3 mt-6 text-[11px] uppercase tracking-[2px] text-gray-500">
              {t('sections.instructions')}
            </Text>
            {data.instructions.map((step, idx) => (
              <View
                key={`step-${idx}`}
                className="mb-3 flex-row gap-3"
              >
                <Text
                  className="w-6 pt-0.5 text-right font-serif-medium text-base text-terracotta-600"
                  style={{ fontVariant: ['tabular-nums'] }}
                >
                  {idx + 1}
                </Text>
                <Text className="flex-1 font-serif text-base leading-6 text-gray-800">
                  {step}
                </Text>
              </View>
            ))}
          </>
        )}

        {isOwner ? (
          <Pressable
            onPress={handleDelete}
            disabled={del.isPending}
            className="mt-10 items-center rounded-lg border border-red-500 py-3"
          >
            {del.isPending ? (
              <ActivityIndicator color="#ef4444" />
            ) : (
              <Text className="text-base font-semibold text-red-600">
                {t('cta.deleteRecipe')}
              </Text>
            )}
          </Pressable>
        ) : null}
      </ScrollView>

      <CookSheet
        visible={cookOpen}
        onClose={() => setCookOpen(false)}
        recipe={data}
        servings={data.servings}
        onCommit={(cookLogId) =>
          setCookToast({ cookLogId, recipeTitle: data.title })
        }
      />

      <ReportSheet
        visible={reportTarget != null}
        onClose={() => setReportTarget(null)}
        subject={
          reportTarget?.kind === 'user'
            ? {
                kind: 'user',
                user_id: data.user_id,
                display_name: authorName.data ?? null,
              }
            : { kind: 'recipe', recipe_id: data.id, title: data.title }
        }
      />

      {/* ─── Save-success editorial toast ────────────────────────────────
          Slides up from below + fades in, auto-dismisses after 4s, "View"
          link replaces the Alert.alert primary button. Matches the visual
          language of the off-recipe-usage toast in pantry.tsx. */}
      {savedToast ? (
        <Animated.View
          style={{
            opacity: savedOpacity,
            transform: [{ translateY: savedTranslate }],
            position: 'absolute',
            left: 16,
            right: 16,
            bottom: 24,
            zIndex: 50,
          }}
          pointerEvents="box-none"
        >
          <View className="flex-row items-center justify-between rounded-lg bg-black px-4 py-3">
            <Text
              className="flex-1 pr-3 font-serif text-base text-white"
              numberOfLines={1}
            >
              {t('toasts.saved')}
            </Text>
            <Pressable
              onPress={() => {
                router.replace(`/recipe/${savedToast.newId}` as any);
              }}
              hitSlop={12}
            >
              <Text className="text-[11px] font-semibold uppercase tracking-[2px] text-terracotta-400">
                {t('toasts.savedView')}
              </Text>
            </Pressable>
          </View>
        </Animated.View>
      ) : null}

      {/* ─── Cook-undo toast (Q11, 10s window) ─────────────────────────
          Slides up after a cook commit. Black pill + white serif body +
          terracotta small-caps Undo action — matches the save toast
          above and the off-recipe-usage toast in pantry.tsx so the
          editorial-toast pattern is uniform across surfaces. */}
      {cookToast ? (
        <Animated.View
          style={{
            opacity: cookOpacity,
            transform: [{ translateY: cookTranslate }],
            position: 'absolute',
            left: 16,
            right: 16,
            bottom: 24,
            zIndex: 50,
          }}
          pointerEvents="box-none"
        >
          <View className="flex-row items-center justify-between rounded-lg bg-black px-4 py-3">
            <Text
              className="flex-1 pr-3 font-serif text-base text-white"
              numberOfLines={1}
            >
              {t('toasts.cookedTitle', { title: cookToast.recipeTitle })}
            </Text>
            <Pressable onPress={handleUndoCook} hitSlop={12}>
              <Text className="text-[11px] font-semibold uppercase tracking-[2px] text-terracotta-400">
                {undoCook.isPending ? t('toasts.undoing') : t('toasts.undo')}
              </Text>
            </Pressable>
          </View>
        </Animated.View>
      ) : null}
    </>
  );
}
