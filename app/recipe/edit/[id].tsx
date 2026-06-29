import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { ActivityIndicator, Alert, Text, View } from 'react-native';
import { useTranslation } from 'react-i18next';

import { RecipeForm } from '@/components/recipe-form';
import { useRecipe, useUpdateRecipe } from '@/lib/queries/recipes';

export default function EditRecipeScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const { data, isLoading, error } = useRecipe(id);
  const update = useUpdateRecipe(id!);
  const { t } = useTranslation('recipe-form');

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
          {(error as Error | undefined)?.message ?? t('screens.notFound')}
        </Text>
      </View>
    );
  }

  return (
    <>
      <Stack.Screen options={{ title: t('screens.editTitle') }} />
      <RecipeForm
        initial={data}
        draftKey={`edit:${id}`}
        submitting={update.isPending}
        submitLabel={t('screens.submitEdit')}
        onSubmit={async (input) => {
          try {
            await update.mutateAsync(input);
            router.back();
          } catch (e: any) {
            Alert.alert(
              t('screens.saveFailedTitle'),
              e.message ?? t('screens.unknownError'),
            );
          }
        }}
      />
    </>
  );
}
