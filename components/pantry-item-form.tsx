import { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useTranslation } from 'react-i18next';

import { DateField } from '@/components/date-field';
import { IngredientPicker } from '@/components/ingredient-picker';
import { toISODate } from '@/lib/dates';
import {
  PANTRY_LOCATIONS,
  PantryItemInput,
  PantryLocation,
} from '@/lib/queries/pantry';

export type PantryFormInitial = {
  ingredient_id: string;
  ingredient_name: string;
  ingredient_shelf_life_days: number | null;
  qty: number;
  unit: string;
  location: PantryLocation;
  location_detail: string | null;
  purchased_at: string | null;
  expires_at: string | null;
  notes: string | null;
};

type Props = {
  initial?: PantryFormInitial;
  submitting: boolean;
  submitLabel: string;
  onSubmit: (input: PantryItemInput) => Promise<void> | void;
  onDelete?: () => void;
};

const COMMON_UNITS = ['g', 'ml', 'pcs', 'tsp', 'tbsp', 'cup'];

function addDaysISO(baseISO: string, days: number): string {
  const d = new Date(baseISO + 'T00:00:00');
  d.setDate(d.getDate() + days);
  return toISODate(d);
}

export function PantryItemForm({
  initial,
  submitting,
  submitLabel,
  onSubmit,
  onDelete,
}: Props) {
  const { t } = useTranslation('pantry');
  const { t: tCommon } = useTranslation('common');

  // Translated chip label for each location enum. Switch keeps typed-keys
  // autocomplete vs. a dynamic t() interpolation. Same pattern as the
  // pantry main tab's SectionBlock.
  const locationLabel = (loc: PantryLocation): string => {
    switch (loc) {
      case 'fridge': return t('locationLabels.fridge');
      case 'freezer': return t('locationLabels.freezer');
      case 'pantry': return t('locationLabels.pantry');
      case 'other': return t('locationLabels.other');
    }
  };

  const [ingredientId, setIngredientId] = useState(initial?.ingredient_id ?? '');
  const [ingredientName, setIngredientName] = useState(initial?.ingredient_name ?? '');
  const [shelfLife, setShelfLife] = useState<number | null>(
    initial?.ingredient_shelf_life_days ?? null,
  );
  const [qty, setQty] = useState(initial?.qty != null ? String(initial.qty) : '');
  const [unit, setUnit] = useState(initial?.unit ?? '');
  const [unitMode, setUnitMode] = useState<'chip' | 'custom'>(
    initial?.unit && !COMMON_UNITS.includes(initial.unit) ? 'custom' : 'chip',
  );
  const [location, setLocation] = useState<PantryLocation>(initial?.location ?? 'pantry');
  const [locationDetail, setLocationDetail] = useState(initial?.location_detail ?? '');
  const [purchasedAt, setPurchasedAt] = useState(initial?.purchased_at ?? toISODate(new Date()));
  const [expiresAt, setExpiresAt] = useState(initial?.expires_at ?? '');
  const [expiresAutoSuggested, setExpiresAutoSuggested] = useState(false);
  const [notes, setNotes] = useState(initial?.notes ?? '');
  const [pickerOpen, setPickerOpen] = useState(false);

  useEffect(() => {
    if (!expiresAt && shelfLife && purchasedAt) {
      setExpiresAt(addDaysISO(purchasedAt, shelfLife));
      setExpiresAutoSuggested(true);
    }
  }, [shelfLife, purchasedAt, expiresAt]);

  const handleExpiresChange = (v: string) => {
    setExpiresAt(v);
    setExpiresAutoSuggested(false);
  };

  const handleSubmit = async () => {
    if (!ingredientId) {
      Alert.alert(t('form.alerts.missingIngredientTitle'));
      return;
    }
    const qtyNum = parseFloat(qty);
    if (!(qtyNum > 0)) {
      Alert.alert(t('form.alerts.missingQtyTitle'));
      return;
    }
    if (!unit.trim()) {
      Alert.alert(t('form.alerts.missingUnitTitle'));
      return;
    }
    await onSubmit({
      ingredient_id: ingredientId,
      qty: qtyNum,
      unit: unit.trim(),
      location,
      location_detail:
        location === 'other' ? locationDetail.trim() || null : null,
      purchased_at: purchasedAt || null,
      expires_at: expiresAt || null,
      notes: notes.trim() || null,
    });
  };

  const confirmDelete = () => {
    if (!onDelete) return;
    Alert.alert(t('form.alerts.removeConfirmTitle'), undefined, [
      { text: tCommon('cancel'), style: 'cancel' },
      { text: t('form.alerts.removeConfirm'), style: 'destructive', onPress: onDelete },
    ]);
  };

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      style={{ flex: 1 }}
    >
      <ScrollView
        contentContainerStyle={{ padding: 20, paddingBottom: 48 }}
        keyboardShouldPersistTaps="handled"
      >
        <Text className="mb-2 text-[11px] uppercase tracking-[2px] text-gray-500">
          {t('form.ingredientEyebrow')}
        </Text>
        <Pressable
          onPress={() => setPickerOpen(true)}
          className="mb-5 flex-row items-center justify-between rounded-lg border border-gray-300 px-4 py-3"
        >
          <Text
            className={`flex-1 font-serif text-base ${
              ingredientName ? 'text-black' : 'text-gray-400'
            }`}
            numberOfLines={1}
          >
            {ingredientName || t('form.ingredientPlaceholder')}
          </Text>
          <Text className="ml-3 text-xl text-gray-400">›</Text>
        </Pressable>

        <View className="mb-2 flex-row gap-3">
          <View className="flex-1">
            <Text className="mb-2 text-[11px] uppercase tracking-[2px] text-gray-500">
              {t('form.quantityEyebrow')}
            </Text>
            <TextInput
              className="rounded-lg border border-gray-300 px-4 py-3 text-base"
              keyboardType="decimal-pad"
              value={qty}
              onChangeText={setQty}
              placeholder={t('form.quantityPlaceholder')}
            />
          </View>
        </View>

        <Text className="mb-2 mt-3 text-[11px] uppercase tracking-[2px] text-gray-500">
          {t('form.unitEyebrow')}
        </Text>
        {unitMode === 'chip' ? (
          <View className="mb-8 flex-row flex-wrap gap-2">
            {COMMON_UNITS.map((u) => {
              const active = unit === u;
              return (
                <Pressable
                  key={u}
                  onPress={() => setUnit(u)}
                  className={`rounded-full border px-3 py-1.5 ${
                    active ? 'border-black bg-black' : 'border-gray-300 bg-white'
                  }`}
                >
                  <Text
                    className={`text-xs font-medium ${active ? 'text-white' : 'text-gray-700'}`}
                  >
                    {u}
                  </Text>
                </Pressable>
              );
            })}
            <Pressable
              onPress={() => {
                setUnitMode('custom');
                setUnit('');
              }}
              className="rounded-full border border-dashed border-gray-400 px-3 py-1.5"
            >
              <Text className="text-xs text-gray-600">{t('form.unitOtherChip')}</Text>
            </Pressable>
          </View>
        ) : (
          <View className="mb-8 flex-row items-center gap-2">
            <TextInput
              className="flex-1 rounded-lg border border-gray-300 px-4 py-3 text-base"
              autoCapitalize="none"
              autoFocus
              value={unit}
              onChangeText={setUnit}
              placeholder={t('form.unitCustomPlaceholder')}
            />
            <Pressable
              onPress={() => {
                setUnitMode('chip');
                setUnit(COMMON_UNITS[0]);
              }}
              hitSlop={6}
              className="px-2 py-1"
            >
              <Text className="text-[10px] uppercase tracking-[2px] text-gray-500">
                {t('form.unitBackToChip')}
              </Text>
            </Pressable>
          </View>
        )}

        <Text className="mb-2 text-[11px] uppercase tracking-[2px] text-gray-500">
          {t('form.locationEyebrow')}
        </Text>
        <View className="mb-8">
          <View className="flex-row flex-wrap gap-2">
            {PANTRY_LOCATIONS.map((loc) => {
              const active = location === loc;
              return (
                <Pressable
                  key={loc}
                  onPress={() => setLocation(loc)}
                  className={`rounded-full border px-3 py-1.5 ${
                    active ? 'border-black bg-black' : 'border-gray-300 bg-white'
                  }`}
                >
                  <Text
                    className={`text-xs font-medium ${active ? 'text-white' : 'text-gray-700'}`}
                  >
                    {locationLabel(loc)}
                  </Text>
                </Pressable>
              );
            })}
          </View>
          {location === 'other' && (
            <TextInput
              className="mt-3 rounded-lg border border-gray-300 px-4 py-3 text-base"
              placeholder={t('form.locationOtherPlaceholder')}
              value={locationDetail}
              onChangeText={setLocationDetail}
              maxLength={40}
              autoCapitalize="none"
            />
          )}
        </View>

        <Text className="mb-2 text-[11px] uppercase tracking-[2px] text-gray-500">
          {t('form.purchasedEyebrow')}
        </Text>
        <View className="mb-5">
          <DateField value={purchasedAt} onChange={setPurchasedAt} />
        </View>

        <Text className="mb-2 text-[11px] uppercase tracking-[2px] text-gray-500">
          {t('form.expiresEyebrow')}
        </Text>
        <View className="mb-8">
          <DateField value={expiresAt} onChange={handleExpiresChange} />
          {expiresAutoSuggested && shelfLife ? (
            <Text className="ml-1 mt-2 text-[10px] uppercase tracking-[2px] text-gray-400">
              {t('form.expiresAutoHint', { days: shelfLife })}
            </Text>
          ) : null}
        </View>

        <Text className="mb-2 text-[11px] uppercase tracking-[2px] text-gray-500">
          {t('form.notesEyebrow')}
        </Text>
        <TextInput
          className="mb-8 rounded-lg border border-gray-300 px-4 py-3 text-base"
          placeholder={t('form.notesPlaceholder')}
          value={notes}
          onChangeText={setNotes}
        />

        <Pressable
          onPress={handleSubmit}
          disabled={submitting}
          className="items-center rounded-lg bg-black py-3"
        >
          {submitting ? (
            <ActivityIndicator color="white" />
          ) : (
            <Text className="text-base font-semibold text-white">{submitLabel}</Text>
          )}
        </Pressable>

        {onDelete && (
          <Pressable onPress={confirmDelete} className="mt-10 items-center py-2">
            <Text className="text-[11px] uppercase tracking-[2px] text-red-600">
              {t('form.removeItem')}
            </Text>
          </Pressable>
        )}
      </ScrollView>

      <IngredientPicker
        visible={pickerOpen}
        onClose={() => setPickerOpen(false)}
        onSelect={(ing) => {
          setIngredientId(ing.id);
          setIngredientName(ing.name);
          setShelfLife(ing.shelf_life_days ?? null);
          if (!unit) {
            setUnit(ing.default_unit);
            if (!COMMON_UNITS.includes(ing.default_unit)) {
              setUnitMode('custom');
            }
          }
        }}
      />
    </KeyboardAvoidingView>
  );
}
