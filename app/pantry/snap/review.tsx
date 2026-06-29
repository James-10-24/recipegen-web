import DateTimePicker, {
  type DateTimePickerEvent,
} from '@react-native-community/datetimepicker';
import { Redirect, Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useMemo, useState } from 'react';
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
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useTranslation } from 'react-i18next';

import { useAuth } from '@/lib/auth-context';
import { addDays, isSameDay, toISODate } from '@/lib/dates';
import {
  type PantryLocation,
  PANTRY_LOCATIONS,
  type SnapItem,
  useAddPantryBatch,
} from '@/lib/queries/pantry';

// Editable row state — extends the AI-returned shape with the
// user-controlled expiry/location and a stable id for FlatList keying.
type Row = {
  rowId: string;
  name: string;
  qty: string; // string for free-form input; coerced on submit
  unit: string;
  expires_at: string | null; // YYYY-MM-DD
  location: PantryLocation | null;
  category: string | null;
  shelf_life_days: number | null;
};

// Category → default location mapping. Wrong defaults push items into
// refrigerated storage (over-conservative on shelf life). The
// risk-asymmetry is right: better to err toward "I'll find this in the
// fridge" than "I assumed pantry but it spoiled." Edge cases like
// onions/potatoes (categorized 'produce' but stored at room temp) get
// corrected via per-row override on the review screen.
const CATEGORY_TO_LOCATION: Record<string, PantryLocation> = {
  produce: 'fridge',
  dairy: 'fridge',
  meat: 'fridge',
  seafood: 'fridge',
  grain: 'pantry',
  pantry: 'pantry',
  other: 'other',
};

function snapToRow(item: SnapItem, idx: number): Row {
  // Pre-fill expiry from today + shelf_life_days. Editable per-row.
  // Pre-fill location from the AI-returned category — uses the
  // mapping above. User overrides per-row on the review screen.
  const expires = item.shelf_life_days
    ? toISODate(addDays(new Date(), item.shelf_life_days))
    : null;
  const location = CATEGORY_TO_LOCATION[item.category] ?? null;
  return {
    rowId: `r${idx}-${Date.now()}`,
    name: item.name,
    qty: String(item.qty),
    unit: item.unit,
    expires_at: expires,
    location,
    category: item.category,
    shelf_life_days: item.shelf_life_days,
  };
}

function freshRow(): Row {
  return {
    rowId: `manual-${Date.now()}`,
    name: '',
    qty: '1',
    unit: 'pcs',
    expires_at: null,
    location: null,
    category: null,
    shelf_life_days: null,
  };
}

/** Format a YYYY-MM-DD date for the per-row "Expires" chip. Caller
 *  passes the localized placeholder for the null case so this stays
 *  i18n-free. */
function shortDate(iso: string | null, placeholder: string): string {
  if (!iso) return placeholder;
  const [y] = iso.split('-');
  if (!y) return iso;
  const date = new Date(`${iso}T00:00:00`);
  return date.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year:
      String(date.getFullYear()) === new Date().getFullYear().toString()
        ? undefined
        : '2-digit',
  });
}

export default function SnapReviewScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { session, loading: authLoading, isGuest } = useAuth();
  const params = useLocalSearchParams<{ items?: string; mode?: string }>();
  const addBatch = useAddPantryBatch();
  const { t } = useTranslation('pantry');
  const { t: tCommon } = useTranslation('common');

  // Translated chip label for a pantry-location enum. Same switch-based
  // pattern as the pantry main tab + pantry-item-form.
  const locationLabel = (loc: PantryLocation): string => {
    switch (loc) {
      case 'fridge': return t('locationLabels.fridge');
      case 'freezer': return t('locationLabels.freezer');
      case 'pantry': return t('locationLabels.pantry');
      case 'other': return t('locationLabels.other');
    }
  };

  const initialRows = useMemo<Row[]>(() => {
    try {
      const parsed: SnapItem[] = JSON.parse(params.items ?? '[]');
      if (!Array.isArray(parsed)) return [];
      return parsed.map(snapToRow);
    } catch {
      return [];
    }
  }, [params.items]);

  const [rows, setRows] = useState<Row[]>(initialRows);
  const [datePickerFor, setDatePickerFor] = useState<string | null>(null);
  /** Batch-level "Purchased on" date — defaults to today (per Q12: the
   *  modal case is snap-at-store or snap-on-return-home). User can adjust
   *  for delayed snaps (shopped Friday, sorting Sunday). Server uses
   *  purchased_at + shelf_life_days to compute expiry, so a wrong default
   *  silently ages every item by N days. */
  const [purchasedAt, setPurchasedAt] = useState<Date>(new Date());
  const [purchasedPickerOpen, setPurchasedPickerOpen] = useState(false);

  if (!authLoading && !session) return <Redirect href="/sign-in" />;
  if (isGuest) return <Redirect href="/sign-in" />;
  if (rows.length === 0 && initialRows.length === 0) {
    // No items came through (deep link, refresh, or extractor returned []).
    // Bounce to the capture screen.
    return <Redirect href="/pantry/snap" />;
  }

  const updateRow = (rowId: string, patch: Partial<Row>) => {
    setRows((prev) =>
      prev.map((r) => (r.rowId === rowId ? { ...r, ...patch } : r)),
    );
  };

  const removeRow = (rowId: string) => {
    setRows((prev) => prev.filter((r) => r.rowId !== rowId));
  };

  const addAnother = () => setRows((prev) => [...prev, freshRow()]);

  const handleDateChange = (rowId: string) => (
    e: DateTimePickerEvent,
    date?: Date,
  ) => {
    if (Platform.OS === 'android') setDatePickerFor(null);
    if (e.type === 'dismissed') return;
    if (date) updateRow(rowId, { expires_at: toISODate(date) });
  };

  const handleRetake = () => {
    Alert.alert(
      t('snapReview.alerts.retakeTitle'),
      t('snapReview.alerts.retakeBody'),
      [
        { text: tCommon('cancel'), style: 'cancel' },
        {
          text: t('snapReview.alerts.retakeConfirm'),
          style: 'destructive',
          onPress: () => router.replace('/pantry/snap' as any),
        },
      ],
    );
  };

  const submit = async () => {
    const purchasedISO = toISODate(purchasedAt);
    const cleaned = rows
      .map((r) => ({
        name: r.name.trim(),
        qty: parseFloat(r.qty) || 0,
        unit: r.unit.trim() || 'pcs',
        expires_at: r.expires_at,
        // Q12: batch-level Purchased-on threaded through to every item.
        // Server (migration 0023's add_pantry_batch) uses this for the
        // expires_at = purchased_at + shelf_life_days computation, so
        // late-snap items keep accurate shelf life.
        purchased_at: purchasedISO,
        location: r.location,
        category: r.category,
        shelf_life_days: r.shelf_life_days,
      }))
      .filter((r) => r.name.length > 0 && r.qty > 0);

    if (cleaned.length === 0) {
      Alert.alert(
        t('snapReview.alerts.nothingTitle'),
        t('snapReview.alerts.nothingBody'),
      );
      return;
    }

    try {
      // RPC returns { added, merged, total } per migration 0023.
      // Pass added + merged through as separate route params so the
      // pantry tab can render Q13's conditional toast:
      //   merged > 0 → "12 added · 3 merged"
      //   merged = 0 → "12 added to pantry"
      const result = await addBatch.mutateAsync(cleaned);
      router.replace({
        pathname: '/(tabs)/pantry',
        params: {
          snapAdded: String(result.added),
          snapMerged: String(result.merged),
        },
      } as any);
    } catch (e: any) {
      Alert.alert(
        t('snapReview.alerts.addFailedTitle'),
        e?.message ?? t('snapReview.alerts.unknownError'),
      );
    }
  };

  const subjectMode = params.mode === 'receipt' ? 'receipt' : 'photo';
  const totalReady = rows.filter(
    (r) => r.name.trim().length > 0 && parseFloat(r.qty) > 0,
  ).length;

  return (
    <KeyboardAvoidingView
      style={{ flex: 1 }}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <Stack.Screen options={{ title: t('snapReview.stackTitle') }} />
      <ScrollView
        contentContainerStyle={{
          padding: 24,
          // Submit-bar height (~56) + bottom safe area + breathing room.
          paddingBottom: 56 + insets.bottom + 32,
        }}
        keyboardShouldPersistTaps="handled"
        className="bg-white"
      >
        <View className="mb-3 flex-row items-baseline justify-between">
          {/* Q4: AI-disclosure header. Was implicit ("Found in your photo")
              — now explicit about provenance. Single line at point of use;
              vanishes once user commits + saves to pantry. The existing
              "Tweak anything that's off" body below already covers the
              review CTA, so no separate disclaimer subline is needed. */}
          <Text className="text-[11px] font-semibold uppercase tracking-[2px] text-terracotta-600">
            {subjectMode === 'receipt'
              ? t('snapReview.aiReadFromReceipt')
              : t('snapReview.aiReadFromPhoto')}
          </Text>
          <Pressable onPress={handleRetake} hitSlop={6}>
            <Text className="text-[11px] uppercase tracking-[2px] text-gray-500 underline">
              {t('snapReview.retake')}
            </Text>
          </Pressable>
        </View>
        <Text className="mb-3 font-serif-bold text-3xl">
          {t('snapReview.countHeader', { count: rows.length })}
        </Text>
        <Text className="mb-6 max-w-[40ch] text-base leading-6 text-gray-600">
          {t('snapReview.body')}
        </Text>

        {/* Q12: batch-level Purchased-on. Tapping the editorial chip
            reveals the native date picker. Applies to all rows;
            per-row override isn't supported (single trip = single date
            in 95%+ of cases). Bounds: today and prior — future dates
            make no semantic sense for "purchased on." */}
        <View className="mb-6">
          <Text className="mb-1 text-[11px] uppercase tracking-[2px] text-gray-500">
            {t('snapReview.purchasedEyebrow')}
          </Text>
          <Pressable
            onPress={() => setPurchasedPickerOpen((v) => !v)}
            hitSlop={6}
          >
            <Text className="font-serif text-2xl italic text-terracotta-600">
              {isSameDay(purchasedAt, new Date())
                ? t('snapReview.todayLabel')
                : purchasedAt.toLocaleDateString(undefined, {
                    weekday: 'long',
                    month: 'short',
                    day: 'numeric',
                  })}
            </Text>
          </Pressable>
          {purchasedPickerOpen && (
            <DateTimePicker
              mode="date"
              value={purchasedAt}
              maximumDate={new Date()}
              minimumDate={addDays(new Date(), -30)}
              onChange={(e: DateTimePickerEvent, date?: Date) => {
                if (Platform.OS === 'android') setPurchasedPickerOpen(false);
                if (e.type === 'dismissed') return;
                if (date) setPurchasedAt(date);
              }}
            />
          )}
        </View>

        <Pressable
          onPress={addAnother}
          className="mb-6 self-start rounded-full border border-gray-300 px-3 py-1.5"
          hitSlop={6}
        >
          <Text className="text-[11px] uppercase tracking-[2px] text-gray-700">
            {t('snapReview.addByHand')}
          </Text>
        </Pressable>

        {rows.map((row, idx) => (
          <View key={row.rowId} className="mb-6 border-b border-gray-100 pb-5">
            <View className="mb-2 flex-row items-baseline">
              <Text className="w-6 text-[10px] uppercase tracking-[2px] text-gray-400">
                {String(idx + 1).padStart(2, '0')}
              </Text>
              <View className="flex-1" />
              <Pressable
                onPress={() => removeRow(row.rowId)}
                hitSlop={6}
              >
                <Text className="text-[11px] uppercase tracking-[2px] text-red-600">
                  {t('snapReview.row.remove')}
                </Text>
              </Pressable>
            </View>

            {/* Name */}
            <TextInput
              className="mb-3 rounded-lg border border-gray-300 px-4 py-3 font-serif text-lg"
              placeholder={t('snapReview.row.namePlaceholder')}
              autoCapitalize="none"
              autoCorrect={false}
              value={row.name}
              onChangeText={(next) => updateRow(row.rowId, { name: next })}
            />

            {/* Qty + unit row */}
            <View className="mb-3 flex-row gap-2">
              <TextInput
                className="w-24 rounded-lg border border-gray-300 px-3 py-3 text-base"
                placeholder={t('snapReview.row.qtyPlaceholder')}
                keyboardType="decimal-pad"
                value={row.qty}
                onChangeText={(next) => updateRow(row.rowId, { qty: next })}
              />
              <TextInput
                className="flex-1 rounded-lg border border-gray-300 px-3 py-3 text-base"
                placeholder={t('snapReview.row.unitPlaceholder')}
                autoCapitalize="none"
                autoCorrect={false}
                value={row.unit}
                onChangeText={(next) => updateRow(row.rowId, { unit: next })}
              />
            </View>

            {/* Expiry */}
            <Pressable
              // Tap toggles open/closed for THIS row. Tapping a different
              // row's expiry implicitly closes the prior one (state holds
              // a single rowId).
              onPress={() =>
                setDatePickerFor((cur) =>
                  cur === row.rowId ? null : row.rowId,
                )
              }
              className="mb-3 rounded-lg border border-gray-300 px-4 py-3"
            >
              <Text className="text-[10px] uppercase tracking-[2px] text-gray-500">
                {t('snapReview.row.expiresEyebrow')}
              </Text>
              <Text
                className={`mt-1 text-base ${
                  row.expires_at ? 'text-gray-900' : 'text-gray-400'
                }`}
              >
                {shortDate(row.expires_at, t('snapReview.row.expiresPlaceholder'))}
              </Text>
            </Pressable>
            {datePickerFor === row.rowId && (
              <DateTimePicker
                mode="date"
                value={
                  row.expires_at
                    ? new Date(`${row.expires_at}T00:00:00`)
                    : new Date()
                }
                minimumDate={new Date()}
                onChange={handleDateChange(row.rowId)}
              />
            )}

            {/* Location chips */}
            <Text className="mb-2 text-[10px] uppercase tracking-[2px] text-gray-500">
              {t('snapReview.row.locationEyebrow')}
            </Text>
            <View className="flex-row flex-wrap gap-2">
              {PANTRY_LOCATIONS.map((loc) => {
                const active = row.location === loc;
                return (
                  <Pressable
                    key={loc}
                    onPress={() =>
                      updateRow(row.rowId, {
                        location: active ? null : loc,
                      })
                    }
                    className={`rounded-full border px-3 py-1.5 ${
                      active
                        ? 'border-black bg-black'
                        : 'border-gray-300 bg-white'
                    }`}
                  >
                    <Text
                      className={`text-[11px] uppercase tracking-[2px] ${
                        active ? 'text-white' : 'text-gray-700'
                      }`}
                    >
                      {locationLabel(loc)}
                    </Text>
                  </Pressable>
                );
              })}
            </View>
          </View>
        ))}

        <Pressable
          onPress={addAnother}
          className="mb-8 self-start py-2"
          hitSlop={6}
        >
          <Text className="text-[11px] uppercase tracking-[2px] text-gray-700">
            {t('snapReview.addAnother')}
          </Text>
        </Pressable>
      </ScrollView>

      {/* Sticky submit bar — uses real safe-area insets so the button
          doesn't crowd the home indicator on iPhone X+ devices. */}
      <View
        className="absolute inset-x-0 bottom-0 border-t border-gray-100 bg-white px-6 pt-3"
        style={{ paddingBottom: insets.bottom + 12 }}
      >
        <Pressable
          onPress={submit}
          disabled={addBatch.isPending || totalReady === 0}
          className={`items-center rounded-lg py-3.5 ${
            addBatch.isPending || totalReady === 0 ? 'bg-gray-300' : 'bg-black'
          }`}
        >
          {addBatch.isPending ? (
            <ActivityIndicator color="white" />
          ) : (
            <Text className="text-base font-semibold text-white">
              {totalReady === 0
                ? t('snapReview.submit.fillOne')
                : t('snapReview.submit.addN', { count: totalReady })}
            </Text>
          )}
        </Pressable>
      </View>
    </KeyboardAvoidingView>
  );
}
