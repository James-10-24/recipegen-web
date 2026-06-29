import { useRouter } from 'expo-router';
import { useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Pressable,
  RefreshControl,
  ScrollView,
  Text,
  View,
} from 'react-native';
import { useTranslation } from 'react-i18next';
import { SafeAreaView } from 'react-native-safe-area-context';

import { useAuth } from '@/lib/auth-context';
import { recipeCoverage } from '@/lib/coverage';
import { useRecipeSlotGate } from '@/lib/gates';
import { usePantryList } from '@/lib/queries/pantry';
import { useRecipesList } from '@/lib/queries/recipes';
import { useMyAiQuota } from '@/lib/queries/subscription';
import {
  RECIPE_CATEGORIES,
  type RecipeCategory,
} from '@/lib/recipe-categories';

const GUEST_RECIPE_CAP = 10;
// Bumped from 50 to 100 in the pricing grill. The cap governs CREATION
// only — Discover clones (saved_from_id != null) are excluded from the
// count. Kept in sync with lib/gates.ts FREE_RECIPE_CAP.
const FREE_RECIPE_CAP = 100;

export default function RecipesScreen() {
  const router = useRouter();
  const { isGuest } = useAuth();
  const { data, isLoading, isRefetching, refetch, error } = useRecipesList();
  const pantry = usePantryList();
  const pantryItems = pantry.data ?? [];
  const quota = useMyAiQuota();
  const { requireRecipeSlot } = useRecipeSlotGate();
  const { t } = useTranslation('recipe-list');
  const { t: tCommon } = useTranslation('common');

  // Localized chip label for a category enum value. The enum strings
  // stay English app-wide (they're shared with DB writes + AI prompts)
  // — we look up display labels only at render.
  const categoryLabel = (c: RecipeCategory): string => {
    switch (c) {
      case 'Breakfast': return t('categoryLabels.Breakfast');
      case 'Lunch': return t('categoryLabels.Lunch');
      case 'Dinner': return t('categoryLabels.Dinner');
      case 'Snack': return t('categoryLabels.Snack');
      case 'Dessert': return t('categoryLabels.Dessert');
      case 'Drink': return t('categoryLabels.Drink');
      default: return c;
    }
  };

  // Total count drives the guest cap (everything they hold counts) and the
  // header chrome. Own-count drives the free-cap gate so clones from
  // Discover don't punish free users.
  const recipeCount = data?.length ?? 0;
  const ownRecipeCount = (data ?? []).filter((r) => r.saved_from_id == null).length;
  const isPro = quota.data?.tier === 'pro';
  const atGuestCap = isGuest && recipeCount >= GUEST_RECIPE_CAP;
  const atFreeCap = !isGuest && !isPro && ownRecipeCount >= FREE_RECIPE_CAP;

  // Category filter — null = "All". Hide categories that no row in the
  // user's library uses so we don't surface filters that produce empty
  // states. The chip row is hidden entirely when the library has no
  // categorized rows yet (e.g. fresh accounts).
  const [activeCategory, setActiveCategory] = useState<RecipeCategory | null>(null);
  const usedCategories = useMemo(() => {
    const set = new Set<RecipeCategory>();
    for (const r of data ?? []) {
      if (r.category) set.add(r.category);
    }
    return set;
  }, [data]);
  const filteredData = useMemo(() => {
    if (!activeCategory) return data ?? [];
    return (data ?? []).filter((r) => r.category === activeCategory);
  }, [data, activeCategory]);

  const handleNewPress = async () => {
    if (atGuestCap) {
      Alert.alert(
        t('guestCapAlert.title'),
        t('guestCapAlert.body', { cap: GUEST_RECIPE_CAP }),
        [
          { text: tCommon('cancel'), style: 'cancel' },
          {
            text: t('guestCapAlert.saveAccount'),
            onPress: () => router.push('/sign-in' as any),
          },
        ],
      );
      return;
    }
    // Free-tier 50-recipe gate. Pro users skip both checks.
    const ok = await requireRecipeSlot();
    if (!ok) return;
    router.push('/recipe/new' as any);
  };

  return (
    <SafeAreaView style={{ flex: 1 }} edges={['top']}>
      <View className="flex-row items-center justify-between px-4 pb-1 pt-2">
        <Text className="font-serif-bold text-3xl">{t('title')}</Text>
        <View className="flex-row items-center gap-4">
          <Pressable
            onPress={() => router.push('/settings' as any)}
            hitSlop={8}
          >
            <Text className="text-[11px] uppercase tracking-[2px] text-gray-600">
              {t('settingsLink')}
            </Text>
          </Pressable>
          <Pressable
            onPress={handleNewPress}
            hitSlop={8}
            className={`rounded-full border px-3 py-1.5 ${
              atGuestCap || atFreeCap
                ? 'border-gray-300 bg-white'
                : 'border-black bg-white'
            }`}
          >
            <Text
              className={`text-[11px] uppercase tracking-[2px] ${
                atGuestCap || atFreeCap ? 'text-gray-400' : 'text-black'
              }`}
            >
              {t('newButton')}
            </Text>
          </Pressable>
        </View>
      </View>
      {isGuest ? (
        <View className="px-4 pb-2">
          <Text className="text-[11px] uppercase tracking-[2px] text-gray-500">
            {t('guestCounter', { count: recipeCount, cap: GUEST_RECIPE_CAP })}
            <Text
              className="text-gray-700 underline"
              onPress={() => router.push('/sign-in' as any)}
            >
              {t('saveAccountLink')}
            </Text>
          </Text>
        </View>
      ) : !isPro ? (
        <View className="px-4 pb-2">
          {/* Free tier counter — italic Fraunces "shelf" metaphor + small-caps
              chrome. Shows the OWN-creation count so the number matches the
              wall users actually hit; clones from Discover are uncounted
              per the pricing grill. */}
          <Text className="text-[11px] uppercase tracking-[2px] text-gray-500">
            {t('freeCounter', { count: ownRecipeCount, cap: FREE_RECIPE_CAP })}
            <Text
              className="text-gray-700 underline"
              onPress={() => router.push('/paywall' as any)}
            >
              {t('liftCapLink')}
            </Text>
          </Text>
        </View>
      ) : null}

      {isLoading ? (
        <View className="flex-1 items-center justify-center">
          <ActivityIndicator />
        </View>
      ) : error ? (
        <View className="flex-1 items-center justify-center px-6">
          <Text className="text-center text-red-600">
            {t('loadError', { message: (error as Error).message })}
          </Text>
        </View>
      ) : (
        <>
          {usedCategories.size > 0 ? (
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 8, gap: 8 }}
            >
              {(['All', ...RECIPE_CATEGORIES.filter((c) => usedCategories.has(c))] as const).map(
                (c) => {
                  const value = c === 'All' ? null : (c as RecipeCategory);
                  const active = activeCategory === value;
                  const label = c === 'All' ? t('categoryAll') : categoryLabel(c as RecipeCategory);
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
                },
              )}
            </ScrollView>
          ) : null}
        <FlatList
          data={filteredData}
          keyExtractor={(item) => item.id}
          contentContainerStyle={{ padding: 16, paddingTop: 8 }}
          ItemSeparatorComponent={() => <View className="h-px bg-gray-100" />}
          refreshControl={
            <RefreshControl refreshing={isRefetching} onRefresh={refetch} />
          }
          renderItem={({ item }) => {
            const cov = recipeCoverage(item.ingredients, pantryItems);
            const showCov = cov.total > 0;
            const fullyCovered = showCov && cov.covered === cov.total;
            return (
              <Pressable
                onPress={() => router.push(`/recipe/${item.id}` as any)}
                className="py-3"
              >
                <View className="flex-row items-baseline justify-between">
                  <Text className="flex-1 font-serif-medium text-lg" numberOfLines={1}>
                    {item.title}
                  </Text>
                  {showCov && (
                    <Text
                      className={`ml-3 text-[11px] uppercase tracking-[1.5px] ${
                        fullyCovered
                          ? 'font-semibold text-forest-700'
                          : 'text-gray-500'
                      }`}
                    >
                      {t('row.pantryCoverage', { covered: cov.covered, total: cov.total })}
                    </Text>
                  )}
                </View>
                {item.description ? (
                  <Text className="mt-0.5 text-sm text-gray-600" numberOfLines={1}>
                    {item.description}
                  </Text>
                ) : null}
                <Text className="mt-1 text-xs text-gray-500">
                  {t('row.servings', { count: item.servings })}
                  {item.prep_min != null ? ` · ${t('row.prepMin', { min: item.prep_min })}` : ''}
                  {item.cook_min != null ? ` · ${t('row.cookMin', { min: item.cook_min })}` : ''}
                </Text>
              </Pressable>
            );
          }}
          ListEmptyComponent={
            activeCategory ? (
              <View className="mt-16 items-center px-8">
                <Text className="font-serif text-2xl italic text-gray-400">
                  {t('emptyFiltered.headline')}
                </Text>
                <Text className="mt-3 max-w-[36ch] text-center text-sm leading-5 text-gray-600">
                  {t('emptyFiltered.body', { category: categoryLabel(activeCategory) })}
                </Text>
                <Pressable
                  onPress={() => setActiveCategory(null)}
                  hitSlop={6}
                  className="mt-4"
                >
                  <Text className="text-[11px] uppercase tracking-[2px] text-gray-700 underline">
                    {t('emptyFiltered.showAll')}
                  </Text>
                </Pressable>
              </View>
            ) : (
              <View className="mt-16 items-center px-8">
                <Text className="font-serif text-2xl italic text-gray-400">
                  {t('emptyAll.headline')}
                </Text>
                <Text className="mt-3 max-w-[36ch] text-center text-sm leading-5 text-gray-600">
                  {t('emptyAll.body')}
                </Text>
                <View className="mt-5 flex-row items-center gap-4">
                  <Pressable
                    onPress={() => router.push('/recipe/new' as any)}
                    className="rounded-full border border-black px-4 py-2"
                  >
                    <Text className="text-[11px] uppercase tracking-[2px] text-black">
                      {t('emptyAll.newRecipe')}
                    </Text>
                  </Pressable>
                  <Pressable
                    onPress={() => router.push('/(tabs)/discover' as any)}
                    hitSlop={6}
                  >
                    <Text className="text-[11px] uppercase tracking-[2px] text-gray-700">
                      {t('emptyAll.browseDiscover')}
                    </Text>
                  </Pressable>
                </View>
              </View>
            )
          }
        />
        </>
      )}
    </SafeAreaView>
  );
}
