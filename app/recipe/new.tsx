import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useState } from 'react';
import { Alert, Pressable, Text, View } from 'react-native';
import { useTranslation } from 'react-i18next';

import { ImportedSourceChip } from '@/components/imported-source-chip';
import { RecipeForm, type RecipeFormInitial } from '@/components/recipe-form';
import { RecipeImportBanner } from '@/components/recipe-import-banner';
import { useAuth } from '@/lib/auth-context';
import { MealType } from '@/lib/queries/meal-plans';
import { useProfile } from '@/lib/queries/profile';
import { useCreateRecipe } from '@/lib/queries/recipes';
import {
  cleanNameForSearch,
  type ImportResult,
  type RecipeSourceKind,
} from '@/lib/recipe-import';

type Params = {
  returnTo?: string;
  date?: string;
  mealType?: MealType;
};

type ImportedExtras = {
  source_url: string | null;
  photo_url: string | null;
  source_kind: RecipeSourceKind | null;
};

export default function NewRecipeScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<Params>();
  const create = useCreateRecipe();
  const profile = useProfile();
  const { isGuest } = useAuth();
  const { t } = useTranslation('recipe-form');
  const { t: tCommon } = useTranslation('common');

  const [formInitial, setFormInitial] = useState<RecipeFormInitial | null>(null);
  const [extras, setExtras] = useState<ImportedExtras>({
    source_url: null,
    photo_url: null,
    source_kind: null,
  });
  // Remounting the form with a new key forces it to pick up `initial` again.
  const [formKey, setFormKey] = useState(0);
  const [formDirty, setFormDirty] = useState(false);
  // Stable identity: RecipeForm's dirty-tracking effect lists onUserEdit as
  // a dependency, so an inline arrow (new every render) would make a mere
  // parent re-render (e.g. the profile query resolving) fire it and flip
  // formDirty spuriously — which then triggers the replace-confirm on every
  // generate. useCallback keeps it stable so only real field edits mark dirty.
  const handleUserEdit = useCallback(() => setFormDirty(true), []);

  const applyImport = (res: ImportResult) => {
    const ingredients: RecipeFormInitial['ingredients'] = [];

    for (const i of res.ingredients) {
      if (!i.match) {
        ingredients.push({
          ingredient_id: '',
          ingredient_name: i.parsed.name || i.parsed.raw,
          qty: i.parsed.qty ?? 0,
          unit: i.parsed.unit ?? '',
          notes: i.parsed.notes,
          pending: {
            raw: i.parsed.raw,
            searchName: cleanNameForSearch(i.parsed.name || i.parsed.raw),
          },
          from_import: { raw: i.parsed.raw },
        });
        continue;
      }

      let unit = i.parsed.unit;
      if (!unit) {
        const isSmallInt =
          i.parsed.qty != null &&
          Number.isInteger(i.parsed.qty) &&
          i.parsed.qty <= 10;
        unit = isSmallInt ? 'pcs' : i.match.default_unit;
      }

      ingredients.push({
        ingredient_id: i.match.ingredient_id,
        ingredient_name: i.match.ingredient_name,
        qty: i.parsed.qty ?? 0,
        unit,
        // Imported raw line lives on `from_import` now; keep notes for
        // user-typed prep hints only.
        notes: i.parsed.notes,
        from_import: { raw: i.parsed.raw },
      });
    }

    setFormInitial({
      title: res.title,
      description: res.description,
      servings: res.servings,
      prep_min: res.prep_min,
      cook_min: res.cook_min,
      instructions: res.instructions,
      category: res.category,
      tags: res.tags,
      ingredients,
    });
    setExtras({
      source_url: res.source_url,
      photo_url: res.photo_url,
      source_kind: res.source_kind,
    });
    setFormDirty(false);
    setFormKey((k) => k + 1);
  };

  const confirmReplace = (): Promise<boolean> =>
    new Promise((resolve) => {
      Alert.alert(
        t('replaceImport.title'),
        t('replaceImport.body'),
        [
          { text: tCommon('cancel'), style: 'cancel', onPress: () => resolve(false) },
          {
            text: t('replaceImport.confirm'),
            style: 'destructive',
            onPress: () => resolve(true),
          },
        ],
      );
    });

  const handleImported = async (res: ImportResult): Promise<boolean> => {
    if (formDirty) {
      const accept = await confirmReplace();
      if (!accept) return false;
    }
    applyImport(res);
    return true;
  };

  const clearImport = () => {
    setExtras({ source_url: null, photo_url: null, source_kind: null });
  };

  return (
    <>
      <Stack.Screen options={{ title: t('screens.newTitle') }} />
      <RecipeForm
        key={formKey}
        initial={formInitial ?? undefined}
        draftKey="new"
        header={
          isGuest ? (
            <View className="mb-6 rounded-lg border border-gray-200 bg-gray-50 p-4">
              <Text className="mb-1 text-[11px] uppercase tracking-[2px] text-gray-500">
                {t('guestAiLock.eyebrow')}
              </Text>
              <Text className="mb-3 font-serif text-base leading-6 text-gray-800">
                {t('guestAiLock.body')}
              </Text>
              <Pressable
                onPress={() => router.push('/sign-in' as any)}
                hitSlop={4}
              >
                <Text className="text-[10px] uppercase tracking-[2px] text-gray-700 underline">
                  {t('guestAiLock.cta')}
                </Text>
              </Pressable>
            </View>
          ) : extras.source_kind ? (
            <>
              {/* AI disclosure — appears whenever content was AI-touched
                  (generated from craving, URL imported via OpenAI fallback,
                  or extracted from pasted text). Pure schema.org URL parses
                  don't show this because no AI was involved. Disclosure
                  vanishes after the user saves; the row in their library
                  becomes user-authored. */}
              {(extras.source_kind === 'ai_generate' ||
                extras.source_kind === 'url_ai' ||
                extras.source_kind === 'paste') && (
                <View className="mb-3">
                  <Text className="text-[11px] uppercase tracking-[2px] text-terracotta-600">
                    {extras.source_kind === 'paste'
                      ? t('aiDisclosure.extractedByAi')
                      : t('aiDisclosure.generatedByAi')}
                  </Text>
                  <Text className="mt-0.5 font-serif text-sm italic text-gray-600">
                    {t('aiDisclosure.reviewBeforeSaving')}
                  </Text>
                </View>
              )}
              <ImportedSourceChip
                sourceKind={extras.source_kind}
                sourceUrl={extras.source_url}
                photoUrl={extras.photo_url}
                onClear={clearImport}
              />
            </>
          ) : (
            <RecipeImportBanner
              onImported={handleImported}
              defaultServings={profile.data?.household_size}
            />
          )
        }
        submitting={create.isPending}
        submitLabel={t('screens.submitNew')}
        onUserEdit={handleUserEdit}
        onSubmit={async (input) => {
          try {
            const id = await create.mutateAsync({
              ...input,
              source_url: extras.source_url,
              photo_url: extras.photo_url,
            });
            if (params.returnTo === 'plan' && params.date && params.mealType) {
              router.replace({
                pathname: '/plan',
                params: {
                  recipeId: id,
                  date: params.date,
                  mealType: params.mealType,
                },
              } as any);
            } else {
              router.replace(`/recipe/${id}` as any);
            }
          } catch (e: any) {
            Alert.alert(
              t('screens.createFailedTitle'),
              e.message ?? t('screens.unknownError'),
            );
          }
        }}
      />
    </>
  );
}
