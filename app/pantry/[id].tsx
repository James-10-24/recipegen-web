import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { ActivityIndicator, Alert, Text, View } from 'react-native';
import { useTranslation } from 'react-i18next';

import { PantryItemForm } from '@/components/pantry-item-form';
import {
  useDeletePantryItem,
  usePantryItem,
  useUpdatePantryItem,
} from '@/lib/queries/pantry';

export default function EditPantryItemScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const { data, isLoading, error } = usePantryItem(id);
  const update = useUpdatePantryItem(id!);
  const del = useDeletePantryItem();
  const { t } = useTranslation('pantry');

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

  const handleDelete = async () => {
    try {
      await del.mutateAsync(id!);
      router.back();
    } catch (e: any) {
      Alert.alert(t('screens.deleteFailedTitle'), e.message ?? t('screens.unknownError'));
    }
  };

  return (
    <>
      <Stack.Screen options={{ title: data.ingredient_name }} />
      <PantryItemForm
        initial={data}
        submitting={update.isPending}
        submitLabel={t('screens.submitEdit')}
        onDelete={handleDelete}
        onSubmit={async (input) => {
          try {
            await update.mutateAsync(input);
            router.back();
          } catch (e: any) {
            Alert.alert(t('screens.saveFailedTitle'), e.message ?? t('screens.unknownError'));
          }
        }}
      />
    </>
  );
}
