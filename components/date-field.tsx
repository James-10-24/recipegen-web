import DateTimePicker, {
  DateTimePickerEvent,
} from '@react-native-community/datetimepicker';
import { useState } from 'react';
import { Modal, Platform, Pressable, Text, View } from 'react-native';
import { useTranslation } from 'react-i18next';

import { toISODate } from '@/lib/dates';

type Props = {
  value: string; // 'YYYY-MM-DD' or ''
  onChange: (iso: string) => void;
  placeholder?: string;
  clearable?: boolean;
};

/** Locale-aware long date format ("Jan 15, 2024" / "2024年1月15日").
 *  Uses Intl.DateTimeFormat via Date.toLocaleDateString so the format
 *  adapts to whatever the device language is — no extra translation
 *  keys needed for a string this composable. */
function formatReadable(iso: string): string {
  const d = new Date(iso + 'T00:00:00');
  return d.toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

export function DateField({ value, onChange, placeholder, clearable = true }: Props) {
  const [showing, setShowing] = useState(false);
  const [draft, setDraft] = useState<Date | null>(null);
  const { t } = useTranslation('common');

  const current = value ? new Date(value + 'T00:00:00') : new Date();

  const open = () => {
    setDraft(current);
    setShowing(true);
  };

  const handleIOSChange = (_e: DateTimePickerEvent, d?: Date) => {
    if (d) setDraft(d);
  };

  const handleAndroidChange = (e: DateTimePickerEvent, d?: Date) => {
    setShowing(false);
    if (e.type === 'set' && d) onChange(toISODate(d));
  };

  const done = () => {
    if (draft) onChange(toISODate(draft));
    setShowing(false);
  };

  const cancel = () => {
    setShowing(false);
    setDraft(null);
  };

  const clear = () => {
    onChange('');
  };

  return (
    <View className="flex-row items-center">
      <Pressable
        onPress={open}
        className="flex-1 rounded-lg border border-gray-300 px-4 py-3"
      >
        <Text className={`text-base ${value ? 'text-black' : 'text-gray-400'}`}>
          {value ? formatReadable(value) : placeholder || t('dateField.selectDate')}
        </Text>
      </Pressable>
      {clearable && value ? (
        <Pressable onPress={clear} hitSlop={8} className="ml-3 px-1 py-2">
          <Text className="text-[10px] uppercase tracking-[2px] text-gray-500">
            {t('dateField.clear')}
          </Text>
        </Pressable>
      ) : null}

      {Platform.OS === 'android' && showing && (
        <DateTimePicker value={current} mode="date" onChange={handleAndroidChange} />
      )}

      {Platform.OS === 'ios' && (
        <Modal visible={showing} transparent animationType="slide" onRequestClose={cancel}>
          <View style={{ flex: 1 }}>
            <Pressable
              onPress={cancel}
              style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.3)' }}
            />
            <View style={{ backgroundColor: 'white', paddingBottom: 24 }}>
              <View className="flex-row items-center justify-between border-b border-gray-100 px-4 py-3">
                <Pressable onPress={cancel} hitSlop={8}>
                  <Text className="text-base text-gray-600">{t('cancel')}</Text>
                </Pressable>
                <Pressable onPress={done} hitSlop={8}>
                  <Text className="text-base font-semibold text-black">{t('done')}</Text>
                </Pressable>
              </View>
              <DateTimePicker
                value={draft ?? current}
                mode="date"
                display="inline"
                themeVariant="light"
                accentColor="#000000"
                onChange={handleIOSChange}
                style={{ backgroundColor: 'white' }}
              />
            </View>
          </View>
        </Modal>
      )}
    </View>
  );
}
