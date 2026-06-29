import { useQueryClient } from '@tanstack/react-query';
import { Image } from 'expo-image';
import { useRouter } from 'expo-router';
import { useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Pressable,
  RefreshControl,
  ScrollView,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useTranslation } from 'react-i18next';
import { SafeAreaView } from 'react-native-safe-area-context';

import { GuestLocked } from '@/components/guest-locked';
import { ReportSheet } from '@/components/report-sheet';
import { useAuth } from '@/lib/auth-context';
import {
  DiscoverRow,
  useDiscoverRecipes,
  useSavedSet,
} from '@/lib/queries/discover';
import { useBlockUser } from '@/lib/queries/moderation';
import {
  RECIPE_CATEGORIES,
  type RecipeCategory,
} from '@/lib/recipe-categories';
import { RECIPE_LANGUAGE_LABEL } from '@/lib/recipe-language';
import { RECIPE_LANGUAGES, useUiLanguage } from '@/lib/ui-language';

/**
 * Tiny in-component debounce. We don't want a network call on every keystroke
 * — both for cost (one trigram query per character) and for UX (the result
 * list flickering as the user types). 250ms feels responsive without firing
 * on partials.
 */
function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const handle = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(handle);
  }, [value, delayMs]);
  return debounced;
}

export default function DiscoverScreen() {
  const router = useRouter();
  const qc = useQueryClient();
  const { isGuest } = useAuth();
  const { t } = useTranslation('discover');
  const { t: tCommon } = useTranslation('common');
  const [query, setQuery] = useState('');
  const debouncedQuery = useDebouncedValue(query, 250);

  // Localized chip label for a category enum value. Enum strings stay
  // English app-wide (shared with DB writes / AI prompts) — display
  // labels are looked up only at render. Same pattern as recipe-list.
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
  // Category filter — null = all categories. Server-side filter (see
  // search_public_recipes p_category) keeps the payload small, especially
  // once the public library grows beyond what one screen of results can
  // surface.
  const [activeCategory, setActiveCategory] = useState<RecipeCategory | null>(null);
  // Language filter — defaults to the user's UI language. NULL on the
  // server means "any language"; legacy / language-unknown rows always
  // pass regardless of the filter (see migration 0032 for the rationale).
  const [uiLanguage] = useUiLanguage();
  const [activeLanguage, setActiveLanguage] = useState<
    (typeof RECIPE_LANGUAGES)[number] | null
  >(uiLanguage);
  // Skip the network call entirely for guests — server would refuse with
  // 42501 anyway, but no point burning the request.
  const { data, isLoading, isRefetching, refetch, error } = useDiscoverRecipes(
    debouncedQuery,
    { enabled: !isGuest, category: activeCategory, language: activeLanguage },
  );

  const visibleIds = useMemo(() => (data ?? []).map((r) => r.id), [data]);
  const savedSet = useSavedSet(visibleIds);

  // Long-press on a Discover tile opens an action sheet for Report/Block —
  // Apple UGC compliance expects flag/block reachable from the discovery
  // surface, not just from the recipe-detail ⋯ menu one tap deeper.
  // The selected row is kept in state so the ReportSheet can build its
  // subject from the tile we long-pressed (recipe title, user_id, etc.).
  const [reportTarget, setReportTarget] = useState<
    | { kind: 'recipe' | 'user'; row: DiscoverRow }
    | null
  >(null);
  const block = useBlockUser();

  const handleBlock = (row: DiscoverRow) => {
    const name = row.author_name ?? t('alerts.thisUserFallback');
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
              await block.mutateAsync(row.user_id);
            } catch (e: any) {
              Alert.alert(t('alerts.blockFailedTitle'), e.message ?? t('alerts.unknownError'));
            }
          },
        },
      ],
    );
  };

  const openRowActions = (row: DiscoverRow) => {
    // Title in the Alert header gives the user something to verify against —
    // they long-pressed a specific tile and the sheet confirms which.
    Alert.alert(row.title, undefined, [
      {
        text: t('alerts.moreReportRecipe'),
        onPress: () => setReportTarget({ kind: 'recipe', row }),
      },
      {
        text: t('alerts.moreReportAuthor'),
        onPress: () => setReportTarget({ kind: 'user', row }),
      },
      { text: t('alerts.moreBlockAuthor'), style: 'destructive', onPress: () => handleBlock(row) },
      { text: tCommon('cancel'), style: 'cancel' },
    ]);
  };

  if (isGuest) {
    return (
      <SafeAreaView style={{ flex: 1 }} edges={['top']} className="bg-white">
        <View className="px-6 pb-3 pt-3">
          <Text className="font-serif-bold text-3xl">{t('title')}</Text>
          <Text className="mt-1 text-[11px] uppercase tracking-[2px] text-gray-500">
            {t('subtitle')}
          </Text>
        </View>
        <GuestLocked
          headline={t('guestGate.headline')}
          body={t('guestGate.body')}
          ctaLabel={t('guestGate.cta')}
        />
      </SafeAreaView>
    );
  }

  // The Discover row already carries author_name (one round-trip in the
  // RPC) — seed the per-user cache before navigating so the recipe detail
  // page doesn't flash a "By …" label on first paint.
  const openRecipe = (item: DiscoverRow) => {
    qc.setQueryData(['author-name', item.user_id], item.author_name);
    router.push(`/recipe/${item.id}` as any);
  };

  return (
    <SafeAreaView style={{ flex: 1 }} edges={['top']} className="bg-white">
      <View className="px-6 pb-3 pt-3">
        <Text className="font-serif-bold text-3xl">{t('title')}</Text>
        <Text className="mt-1 text-[11px] uppercase tracking-[2px] text-gray-500">
          {t('subtitle')}
        </Text>
      </View>

      <View className="px-6 pb-3">
        <TextInput
          className="rounded-lg border border-gray-300 px-4 py-3 text-base"
          placeholder={t('searchPlaceholder')}
          autoCapitalize="none"
          autoCorrect={false}
          // iOS-only — Android renders this prop as a no-op. The X-circle
          // shows once the field has content and clears it on tap; without
          // it users have to backspace-hold on long queries.
          clearButtonMode="while-editing"
          value={query}
          onChangeText={setQuery}
        />
      </View>

      {/* Language chip row — sits above category chips. Defaults to UI
          language so a Chinese-UI user sees Chinese recipes by default;
          they tap "All" to expand. Server passes NULL legacy-language
          rows through any filter so the feed never strands old data. */}
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={{ paddingHorizontal: 24, paddingBottom: 8, gap: 8 }}
      >
        {(['All', ...RECIPE_LANGUAGES] as const).map((lang) => {
          const value = lang === 'All' ? null : lang;
          const active = activeLanguage === value;
          // Language labels stay in their own language (English / 中文)
          // so each label is readable to a speaker of that language.
          const label =
            lang === 'All' ? t('filters.allLanguages') : RECIPE_LANGUAGE_LABEL[lang];
          return (
            <Pressable
              key={lang}
              onPress={() => setActiveLanguage(value)}
              className={`rounded-full border px-3 py-1.5 ${
                active ? 'border-black bg-black' : 'border-gray-300 bg-white'
              }`}
            >
              <Text
                className={`text-[11px] uppercase tracking-[2px] ${
                  active ? 'text-white' : 'text-gray-700'
                }`}
              >
                {label}
              </Text>
            </Pressable>
          );
        })}
      </ScrollView>

      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={{ paddingHorizontal: 24, paddingBottom: 12, gap: 8 }}
      >
        {(['All', ...RECIPE_CATEGORIES] as const).map((c) => {
          const value = c === 'All' ? null : (c as RecipeCategory);
          const active = activeCategory === value;
          const label = c === 'All' ? t('filters.allCategories') : categoryLabel(c as RecipeCategory);
          return (
            <Pressable
              key={c}
              onPress={() => setActiveCategory(value)}
              className={`rounded-full border px-3 py-1.5 ${
                active ? 'border-black bg-black' : 'border-gray-300 bg-white'
              }`}
            >
              <Text
                className={`text-[11px] uppercase tracking-[2px] ${
                  active ? 'text-white' : 'text-gray-700'
                }`}
              >
                {label}
              </Text>
            </Pressable>
          );
        })}
      </ScrollView>

      {isLoading ? (
        <View className="flex-1 items-center justify-center">
          <ActivityIndicator color="#000" />
        </View>
      ) : error ? (
        <View className="flex-1 items-center justify-center px-6">
          <Text className="text-center text-red-600">{(error as Error).message}</Text>
        </View>
      ) : (
        <FlatList<DiscoverRow>
          data={data ?? []}
          keyExtractor={(r) => r.id}
          contentContainerStyle={{ paddingHorizontal: 24, paddingBottom: 48 }}
          // Magazine cards: each row gets generous vertical rhythm, no
          // hairline divider between them — the photo + whitespace does
          // the separating.
          ItemSeparatorComponent={() => <View className="h-6" />}
          refreshControl={
            <RefreshControl refreshing={isRefetching} onRefresh={refetch} tintColor="#000" />
          }
          ListEmptyComponent={
            <View className="mt-16 items-center px-4">
              <Text className="font-serif text-2xl italic text-gray-400">
                {query.trim() || activeCategory
                  ? t('empty.noMatchesHeadline')
                  : t('empty.quietShelfHeadline')}
              </Text>
              <Text className="mt-3 max-w-[36ch] text-center text-sm leading-5 text-gray-600">
                {query.trim()
                  ? t('empty.tryDifferentSearch')
                  : activeCategory
                    ? t('empty.noPublicInCategory', {
                        category: categoryLabel(activeCategory),
                      })
                    : t('empty.noPublicEver')}
              </Text>
              {activeCategory && (
                <Pressable
                  onPress={() => setActiveCategory(null)}
                  hitSlop={6}
                  className="mt-4"
                >
                  <Text className="text-[11px] uppercase tracking-[2px] text-gray-700 underline">
                    {t('empty.showAllCategories')}
                  </Text>
                </Pressable>
              )}
              {!query.trim() && !activeCategory && (
                <Pressable
                  onPress={() => router.push('/recipe/new' as any)}
                  className="mt-5 rounded-full border border-black px-4 py-2"
                >
                  <Text className="text-[11px] uppercase tracking-[2px] text-black">
                    {t('empty.newRecipe')}
                  </Text>
                </Pressable>
              )}
            </View>
          }
          renderItem={({ item }) => {
            const isSaved = savedSet.data?.has(item.id) ?? false;
            return (
              <Pressable
                onPress={() => openRecipe(item)}
                onLongPress={() => openRowActions(item)}
                // 300ms feels native — long enough that a slightly-slow
                // tap doesn't fire it, short enough that holding feels
                // intentional rather than tedious.
                delayLongPress={300}
                className="pt-1"
              >
                {item.photo_url ? (
                  <View className="overflow-hidden rounded-lg border border-gray-100">
                    <Image
                      source={{ uri: item.photo_url }}
                      style={{ width: '100%', aspectRatio: 16 / 9 }}
                      contentFit="cover"
                      transition={200}
                    />
                  </View>
                ) : (
                  // Cream + Fraunces letter fallback — same posture as the
                  // photo placeholder elsewhere in the app, scaled up to
                  // the magazine card aspect ratio.
                  <View
                    className="items-center justify-center rounded-lg bg-cream-50 border border-gray-100"
                    style={{ width: '100%', aspectRatio: 16 / 9, backgroundColor: '#faf6f0' }}
                  >
                    <Text className="font-serif text-6xl italic text-gray-300">
                      {item.title?.[0]?.toUpperCase() ?? '·'}
                    </Text>
                  </View>
                )}
                <View className="mt-3 flex-row items-start justify-between gap-3">
                  <Text className="flex-1 font-serif-medium text-xl" numberOfLines={2}>
                    {item.title}
                  </Text>
                  {isSaved && (
                    <Text className="ml-2 mt-1 text-[10px] font-semibold uppercase tracking-[2px] text-forest-700">
                      {t('card.savedBadge')}
                    </Text>
                  )}
                </View>
                {item.description ? (
                  <Text className="mt-1 text-sm text-gray-600" numberOfLines={2}>
                    {item.description}
                  </Text>
                ) : null}
                {/* Editorial byline: tracked "BY" + italic terracotta name,
                    same sibling-Text pattern used on the recipe detail
                    screen so cohesion holds across surfaces. */}
                <View className="mt-2 flex-row flex-wrap items-baseline">
                  <Text className="text-[11px] uppercase tracking-[2px] text-gray-500">
                    {t('card.by')}
                  </Text>
                  <Text className="ml-1.5 font-serif text-base italic text-terracotta-600">
                    {item.author_name ?? t('card.anonymousAuthor')}
                  </Text>
                  <Text className="ml-2 text-[11px] uppercase tracking-[2px] text-gray-400">
                    {t('card.meta', { count: item.servings })}
                    {item.prep_min != null ? t('card.prepMin', { min: item.prep_min }) : ''}
                  </Text>
                </View>
              </Pressable>
            );
          }}
        />
      )}

      {/* ReportSheet is always rendered so the slide-out animation plays
          on close. The placeholder subject keeps TypeScript happy during
          the brief window between setReportTarget(null) and Modal unmount. */}
      <ReportSheet
        visible={reportTarget != null}
        onClose={() => setReportTarget(null)}
        subject={
          reportTarget?.kind === 'user'
            ? {
                kind: 'user',
                user_id: reportTarget.row.user_id,
                display_name: reportTarget.row.author_name ?? null,
              }
            : reportTarget?.kind === 'recipe'
              ? {
                  kind: 'recipe',
                  recipe_id: reportTarget.row.id,
                  title: reportTarget.row.title,
                }
              : { kind: 'recipe', recipe_id: '', title: '' }
        }
      />
    </SafeAreaView>
  );
}
