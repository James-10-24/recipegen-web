import { Stack } from 'expo-router';
import { useMemo } from 'react';
import { ActivityIndicator, FlatList, Text, View } from 'react-native';
import { useTranslation } from 'react-i18next';

import { monthDay } from '@/lib/dates';
import { CompletedList, useCompletedLists } from '@/lib/queries/grocery';

export default function HistoryScreen() {
  const { data, isLoading, error } = useCompletedLists();
  const { t } = useTranslation('shop');
  const { t: tCommon } = useTranslation('common');

  // Localized month-short labels for the range header + completed-on
  // line. Mirrors the useShopDateLabels pattern from the shop tab.
  const monthLabels = useMemo(
    () => [
      tCommon('dates.monthShort.jan'),
      tCommon('dates.monthShort.feb'),
      tCommon('dates.monthShort.mar'),
      tCommon('dates.monthShort.apr'),
      tCommon('dates.monthShort.may'),
      tCommon('dates.monthShort.jun'),
      tCommon('dates.monthShort.jul'),
      tCommon('dates.monthShort.aug'),
      tCommon('dates.monthShort.sep'),
      tCommon('dates.monthShort.oct'),
      tCommon('dates.monthShort.nov'),
      tCommon('dates.monthShort.dec'),
    ],
    [tCommon],
  );

  const formatCompletedAt = (iso: string): string => {
    const d = new Date(iso);
    return `${monthDay(d, monthLabels)}, ${d.getFullYear()}`;
  };

  return (
    <>
      <Stack.Screen options={{ title: t('history.stackTitle') }} />
      {isLoading ? (
        <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center' }}>
          <ActivityIndicator color="#000" />
        </View>
      ) : error ? (
        <View className="flex-1 items-center justify-center px-6">
          <Text className="text-center text-red-600">
            {(error as Error).message}
          </Text>
        </View>
      ) : (
        <FlatList<CompletedList>
          data={data ?? []}
          keyExtractor={(r) => r.id}
          contentContainerStyle={{ paddingHorizontal: 24, paddingVertical: 16 }}
          ItemSeparatorComponent={() => <View className="h-px bg-gray-100" />}
          ListEmptyComponent={
            <View className="mt-20 items-center px-4">
              <Text className="font-serif text-2xl italic text-gray-400">
                {t('history.emptyHeadline')}
              </Text>
              <Text className="mt-2 text-center text-sm text-gray-500">
                {t('history.emptyBody')}
              </Text>
            </View>
          }
          renderItem={({ item }) => {
            const start = new Date(item.range_start + 'T00:00:00');
            const end = new Date(item.range_end + 'T00:00:00');
            return (
              <View className="py-4">
                <Text className="font-serif text-lg">
                  {t('history.rangeLine', {
                    start: monthDay(start, monthLabels),
                    end: monthDay(end, monthLabels),
                  })}
                </Text>
                <Text className="mt-1 text-[11px] uppercase tracking-[2px] text-gray-500">
                  {t('history.summary', {
                    count: item.item_count,
                    when: formatCompletedAt(item.completed_at),
                  })}
                </Text>
              </View>
            );
          }}
        />
      )}
    </>
  );
}
