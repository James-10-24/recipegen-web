import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Modal,
  Pressable,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useTranslation } from 'react-i18next';

import { invalidateAiUsage } from '@/lib/queries/ai-usage';
import {
  IngredientSearchResult,
  useCreateIngredient,
  useIngredientSearch,
} from '@/lib/queries/ingredients';
import {
  normalizeIngredient,
  type IngredientNormalization,
} from '@/lib/recipe-import';
import { supabase } from '@/lib/supabase';

const UNIT_OPTIONS = ['g', 'ml', 'pcs', 'tsp', 'tbsp', 'cup'];

type Props = {
  visible: boolean;
  onClose: () => void;
  onSelect: (ingredient: IngredientSearchResult) => void;
  /** Optional pre-filled search term when opening (e.g. an imported raw name). */
  initialQuery?: string;
};

export function IngredientPicker({ visible, onClose, onSelect, initialQuery }: Props) {
  const qc = useQueryClient();
  const { t } = useTranslation('common');
  const [query, setQuery] = useState(initialQuery ?? '');
  const [newUnit, setNewUnit] = useState('g');
  const [suggestion, setSuggestion] = useState<IngredientNormalization | null>(null);
  const [suggestionFor, setSuggestionFor] = useState<string | null>(null);
  const [refining, setRefining] = useState(false);

  useEffect(() => {
    if (visible) {
      setQuery(initialQuery ?? '');
      setSuggestion(null);
      setSuggestionFor(null);
    }
  }, [visible, initialQuery]);
  const search = useIngredientSearch(query);
  const create = useCreateIngredient();

  const trimmed = query.trim();
  const exactMatch = search.data?.some((r) => r.name.toLowerCase() === trimmed.toLowerCase());
  const canAddNew = trimmed.length >= 2 && !exactMatch && !search.isFetching;

  // Reset the suggestion if the user keeps typing past it.
  useEffect(() => {
    if (
      suggestionFor &&
      trimmed.toLowerCase() !== suggestionFor.toLowerCase()
    ) {
      setSuggestion(null);
      setSuggestionFor(null);
    }
  }, [trimmed, suggestionFor]);

  const handleSelect = (ing: IngredientSearchResult) => {
    onSelect(ing);
    setQuery('');
    setSuggestion(null);
    setSuggestionFor(null);
    onClose();
  };

  const doCreate = async (
    overrides?: Partial<{
      name: string;
      default_unit: string;
      category: string | null;
      aliases: string[];
      shelf_life_days: number | null;
      density_g_per_ml: number | null;
    }>,
  ) => {
    try {
      const created = await create.mutateAsync({
        name: overrides?.name ?? trimmed,
        default_unit: overrides?.default_unit ?? newUnit,
        category: overrides?.category ?? null,
        aliases: overrides?.aliases ?? [],
        shelf_life_days: overrides?.shelf_life_days ?? null,
        density_g_per_ml: overrides?.density_g_per_ml ?? null,
      });
      handleSelect(created);
    } catch (e: any) {
      Alert.alert(
        t('ingredientPicker.alerts.addFailedTitle'),
        e.message ?? t('ingredientPicker.alerts.unknownError'),
      );
    }
  };

  const handleAddNew = () => {
    // Canonicalization guard: if search surfaced a near-match, nudge the user
    // to reuse it before creating a duplicate.
    const top = search.data?.[0];
    if (top && top.similarity >= 0.55) {
      Alert.alert(
        t('ingredientPicker.alerts.dupeTitle', { name: top.name }),
        t('ingredientPicker.alerts.dupeBody'),
        [
          {
            text: t('ingredientPicker.alerts.useExisting', { name: top.name }),
            onPress: () => handleSelect(top),
          },
          {
            text: t('ingredientPicker.alerts.createAnyway', { name: trimmed }),
            style: 'destructive',
            onPress: () => doCreate(),
          },
        ],
      );
      return;
    }
    doCreate();
  };

  const handleRefine = async () => {
    if (!trimmed) return;
    setRefining(true);
    try {
      const s = await normalizeIngredient(trimmed);
      invalidateAiUsage(qc);
      setSuggestion(s);
      setSuggestionFor(trimmed);
    } catch (e: any) {
      // Even on failure the placeholder may have been finalized; refresh.
      invalidateAiUsage(qc);
      Alert.alert(
        t('ingredientPicker.alerts.refineFailedTitle'),
        e.message ?? t('ingredientPicker.alerts.unknownError'),
      );
    } finally {
      setRefining(false);
    }
  };

  const acceptSuggestion = async () => {
    if (!suggestion) return;
    // Before creating, look for an existing canonical of the same name so we
    // don't duplicate (e.g. user typed "evoo" → AI suggests "Olive oil",
    // which already exists in the seed catalog).
    const { data: existing } = await supabase.rpc('search_ingredients', {
      q: suggestion.canonical_name,
      lim: 1,
    });
    const top = (existing as IngredientSearchResult[] | null)?.[0];
    if (top && top.similarity >= 0.7) {
      handleSelect(top);
      return;
    }
    await doCreate({
      name: suggestion.canonical_name,
      default_unit: suggestion.default_unit,
      category: suggestion.category,
      aliases: suggestion.aliases,
      shelf_life_days: suggestion.shelf_life_days,
      density_g_per_ml: suggestion.density_g_per_ml,
    });
  };

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet">
      <View className="flex-1 bg-white px-4 pt-4">
        <View className="mb-3 flex-row items-center justify-between">
          <Text className="font-serif-bold text-xl">{t('ingredientPicker.title')}</Text>
          <Pressable onPress={onClose} hitSlop={12}>
            <Text className="text-base text-gray-600">{t('cancel')}</Text>
          </Pressable>
        </View>

        <TextInput
          className="mb-3 rounded-lg border border-gray-300 px-4 py-3 text-base"
          placeholder={t('ingredientPicker.searchPlaceholder')}
          autoCapitalize="none"
          autoCorrect={false}
          autoFocus
          value={query}
          onChangeText={setQuery}
        />

        {search.isFetching && <ActivityIndicator className="my-2" color="#000" />}

        <FlatList
          data={search.data ?? []}
          keyExtractor={(item) => item.id}
          keyboardShouldPersistTaps="handled"
          ItemSeparatorComponent={() => <View className="h-px bg-gray-100" />}
          renderItem={({ item }) => (
            <Pressable onPress={() => handleSelect(item)} className="py-3">
              <Text className="font-serif text-base">{item.name}</Text>
              {item.category && (
                <Text className="mt-0.5 text-[10px] uppercase tracking-[2px] text-gray-500">
                  {item.category} · {item.default_unit}
                  {item.user_id ? t('ingredientPicker.rowSuffixYours') : ''}
                </Text>
              )}
            </Pressable>
          )}
          ListEmptyComponent={
            !search.isFetching && trimmed.length >= 1 ? (
              // The "Add as new ingredient" affordance lives BELOW this
              // FlatList — point at it explicitly so the user knows the
              // path forward without leaving the picker.
              <View className="items-center py-6">
                <Text className="font-serif text-base italic text-gray-500">
                  {t('ingredientPicker.empty.headline')}
                </Text>
                <Text className="mt-1 max-w-[32ch] text-center text-xs text-gray-500">
                  {t('ingredientPicker.empty.body', { name: trimmed })}
                </Text>
              </View>
            ) : null
          }
        />

        {canAddNew && !suggestion && (
          <View className="border-t border-gray-200 py-4">
            <Text className="mb-2 text-[11px] uppercase tracking-[2px] text-gray-500">
              {t('ingredientPicker.newSection.eyebrow', { name: trimmed })}
            </Text>
            <View className="mb-3 flex-row flex-wrap gap-2">
              {UNIT_OPTIONS.map((u) => (
                <Pressable
                  key={u}
                  onPress={() => setNewUnit(u)}
                  className={`rounded-full border px-3 py-1.5 ${
                    newUnit === u ? 'border-black bg-black' : 'border-gray-300 bg-white'
                  }`}
                >
                  <Text className={`text-xs ${newUnit === u ? 'text-white' : 'text-gray-700'}`}>
                    {u}
                  </Text>
                </Pressable>
              ))}
            </View>
            <Pressable
              onPress={handleAddNew}
              disabled={create.isPending}
              className="mb-2 items-center rounded-lg bg-black py-3"
            >
              {create.isPending ? (
                <ActivityIndicator color="white" />
              ) : (
                <Text className="text-base font-semibold text-white">
                  {t('ingredientPicker.newSection.addNew')}
                </Text>
              )}
            </Pressable>
            <Pressable
              onPress={handleRefine}
              disabled={refining}
              hitSlop={6}
              className="items-center py-2"
            >
              {refining ? (
                <ActivityIndicator color="#000" />
              ) : (
                <Text className="text-[11px] uppercase tracking-[2px] text-gray-700">
                  {t('ingredientPicker.newSection.refineWithAi')}
                </Text>
              )}
            </Pressable>
          </View>
        )}

        {suggestion && (
          <View className="border-t border-gray-200 py-4">
            <Text className="mb-2 text-[10px] uppercase tracking-[2px] text-gray-500">
              {t('ingredientPicker.suggestion.eyebrow')}
            </Text>
            <Text className="font-serif text-lg">{suggestion.canonical_name}</Text>
            <Text className="mt-1 text-[10px] uppercase tracking-[2px] text-gray-500">
              {t('ingredientPicker.suggestion.metaLine', {
                category: suggestion.category,
                unit: suggestion.default_unit,
              })}
              {suggestion.shelf_life_days != null
                ? t('ingredientPicker.suggestion.keepsSuffix', {
                    days: suggestion.shelf_life_days,
                  })
                : ''}
            </Text>
            {suggestion.aliases.length > 0 && (
              <Text className="mt-1 text-xs text-gray-600" numberOfLines={2}>
                {t('ingredientPicker.suggestion.alsoKnownAs', {
                  aliases: suggestion.aliases.join(', '),
                })}
              </Text>
            )}
            <View className="mt-3 flex-row gap-2">
              <Pressable
                onPress={acceptSuggestion}
                disabled={create.isPending}
                className="flex-1 items-center rounded-lg bg-black py-3"
              >
                {create.isPending ? (
                  <ActivityIndicator color="white" />
                ) : (
                  <Text className="text-[11px] uppercase tracking-[2px] text-white">
                    {t('ingredientPicker.suggestion.useSuggestion')}
                  </Text>
                )}
              </Pressable>
              <Pressable
                onPress={() => {
                  setSuggestion(null);
                  setSuggestionFor(null);
                }}
                className="flex-1 items-center rounded-lg border border-gray-300 py-3"
              >
                <Text className="text-[11px] uppercase tracking-[2px] text-gray-700">
                  {t('ingredientPicker.suggestion.stickWith', { name: trimmed })}
                </Text>
              </Pressable>
            </View>
          </View>
        )}
      </View>
    </Modal>
  );
}
