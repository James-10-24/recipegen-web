import { Image } from 'expo-image';
import { Pressable, Text, View } from 'react-native';
import { useTranslation } from 'react-i18next';

import type { RecipeSourceKind } from '@/lib/recipe-import';

type Props = {
  sourceKind: RecipeSourceKind;
  sourceUrl: string | null;
  photoUrl: string | null;
  onClear: () => void;
};

function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

export function ImportedSourceChip({
  sourceKind,
  sourceUrl,
  photoUrl,
  onClear,
}: Props) {
  const { t } = useTranslation('recipe-form');

  // Resolve the chip label from the four source kinds. Switch keeps the
  // typed-key augmentation honest vs. a dynamic interpolation.
  const label = ((): string => {
    if (sourceKind === 'ai_generate') return t('importedSourceChip.generatedByAi');
    if (sourceKind === 'paste') return t('importedSourceChip.extractedFromPaste');
    const host = sourceUrl ? hostnameOf(sourceUrl) : t('importedSourceChip.unknownHost');
    if (sourceKind === 'url_ai') return t('importedSourceChip.importedAiFrom', { host });
    return t('importedSourceChip.importedFrom', { host });
  })();

  return (
    <View className="mb-6 border-b border-gray-100 pb-6">
      {photoUrl ? (
        <View className="mb-3 overflow-hidden rounded-lg border border-gray-100">
          <Image
            source={{ uri: photoUrl }}
            style={{ width: '100%', aspectRatio: 16 / 9 }}
            contentFit="cover"
            transition={200}
          />
        </View>
      ) : null}
      <View className="flex-row items-center justify-between">
        <Text className="text-[11px] uppercase tracking-[2px] text-gray-500">
          {label}
        </Text>
        <Pressable onPress={onClear} hitSlop={8}>
          <Text className="text-[10px] uppercase tracking-[2px] text-gray-500">
            {t('importedSourceChip.clear')}
          </Text>
        </Pressable>
      </View>
    </View>
  );
}
