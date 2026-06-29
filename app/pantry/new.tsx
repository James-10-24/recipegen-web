import { Stack, useRouter } from 'expo-router';
import { Alert } from 'react-native';
import { useTranslation } from 'react-i18next';

import { PantryItemForm } from '@/components/pantry-item-form';
import { useAddPantryItem } from '@/lib/queries/pantry';

export default function NewPantryItemScreen() {
  const router = useRouter();
  const add = useAddPantryItem();
  const { t } = useTranslation('pantry');

  return (
    <>
      <Stack.Screen options={{ title: t('screens.newTitle') }} />
      <PantryItemForm
        submitting={add.isPending}
        submitLabel={t('screens.submitNew')}
        onSubmit={async (input) => {
          try {
            await add.mutateAsync(input);
            router.back();
          } catch (e: any) {
            Alert.alert(t('screens.addFailedTitle'), e.message ?? t('screens.unknownError'));
          }
        }}
      />
    </>
  );
}
