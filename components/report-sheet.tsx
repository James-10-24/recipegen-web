import { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Modal,
  Pressable,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useTranslation } from 'react-i18next';

import {
  ReportReason,
  ReportSubject,
  useSubmitReport,
} from '@/lib/queries/moderation';

const REASONS: ReportReason[] = ['inappropriate', 'spam', 'incorrect', 'other'];
const NOTES_MAX_LEN = 1000;

type Props = {
  visible: boolean;
  onClose: () => void;
  subject:
    | { kind: 'recipe'; recipe_id: string; title: string }
    | { kind: 'user'; user_id: string; display_name: string | null };
};

export function ReportSheet({ visible, onClose, subject }: Props) {
  const [reason, setReason] = useState<ReportReason>('inappropriate');
  const [notes, setNotes] = useState('');
  const [doneFlash, setDoneFlash] = useState(false);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const submit = useSubmitReport();
  const { t } = useTranslation('common');

  // Translated chip label for a reason enum. Switch keeps typed-keys
  // safety; dynamic interpolation would break the augmentation.
  const reasonLabel = (r: ReportReason): string => {
    switch (r) {
      case 'inappropriate': return t('reportSheet.reasons.inappropriate');
      case 'spam': return t('reportSheet.reasons.spam');
      case 'incorrect': return t('reportSheet.reasons.incorrect');
      case 'other': return t('reportSheet.reasons.other');
    }
  };

  useEffect(() => {
    if (visible) {
      setReason('inappropriate');
      setNotes('');
      setDoneFlash(false);
    }
  }, [visible]);

  // Always clear the auto-close timer on unmount or before scheduling a new
  // one — otherwise a fast Cancel during the success flash would invoke
  // onClose() on an unmounted parent.
  useEffect(() => {
    return () => {
      if (closeTimer.current) {
        clearTimeout(closeTimer.current);
        closeTimer.current = null;
      }
    };
  }, []);

  // Header stays terse so it doesn't truncate; the full subject (recipe
  // title or user name, possibly long) renders below as a small-caps line.
  const headerLabel =
    subject.kind === 'recipe' ? t('reportSheet.headerRecipe') : t('reportSheet.headerUser');
  const subjectLabel =
    subject.kind === 'recipe'
      ? subject.title
      : subject.display_name ?? t('reportSheet.unnamedUser');

  const trimmedNotes = notes.trim();
  // Reason='other' demands at least a short note — without it a moderator
  // gets reason=other, notes=null, which isn't actionable. Server enforces
  // via CHECK constraint; this catches it before round-tripping.
  const otherNeedsNotes = reason === 'other' && trimmedNotes.length === 0;
  const submitDisabled =
    submit.isPending || doneFlash || otherNeedsNotes;

  const handleSubmit = async () => {
    if (otherNeedsNotes) return;
    try {
      await submit.mutateAsync({
        subject_kind: subject.kind as ReportSubject,
        recipe_id: subject.kind === 'recipe' ? subject.recipe_id : undefined,
        reported_user_id: subject.kind === 'user' ? subject.user_id : undefined,
        reason,
        notes: trimmedNotes || null,
      });
      // Flash a success state inside the sheet, then auto-close.
      setDoneFlash(true);
      if (closeTimer.current) clearTimeout(closeTimer.current);
      closeTimer.current = setTimeout(() => {
        closeTimer.current = null;
        onClose();
      }, 1500);
    } catch (e: any) {
      // Postgres rate-limit triggers raise SQLSTATE 42901 (per-day cap) and
      // 42902 (per-target dedupe). Surface them with friendlier copy than
      // the raw exception text.
      const msg = e?.message ?? '';
      const code = e?.code ?? '';
      if (code === '42901' || /rate limit/i.test(msg)) {
        Alert.alert(
          t('reportSheet.alerts.rateLimitTitle'),
          t('reportSheet.alerts.rateLimitBody'),
        );
      } else if (code === '42902' || /already reported/i.test(msg)) {
        Alert.alert(
          t('reportSheet.alerts.dupeTitle'),
          t('reportSheet.alerts.dupeBody'),
        );
      } else {
        Alert.alert(
          t('reportSheet.alerts.sendFailedTitle'),
          msg || t('reportSheet.alerts.unknownError'),
        );
      }
    }
  };

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet">
      <View className="flex-1 bg-white px-5 pt-4">
        <View className="mb-4 flex-row items-start justify-between border-b border-gray-100 pb-3">
          <View className="flex-1 pr-3">
            <Text className="font-serif-bold text-xl">{headerLabel}</Text>
            <Text
              className="mt-1 text-[11px] uppercase tracking-[2px] text-gray-500"
              numberOfLines={2}
            >
              {subjectLabel}
            </Text>
          </View>
          <Pressable onPress={onClose} hitSlop={12} className="pt-1">
            {/* Small-caps Cancel — matches the chrome treatment used by
                Settings, the recipe form, and other sheets in the app
                rather than the platform-default text-base button. */}
            <Text className="text-[11px] uppercase tracking-[2px] text-gray-600">
              {t('cancel')}
            </Text>
          </Pressable>
        </View>

        <Text className="mb-2 text-[11px] uppercase tracking-[2px] text-gray-500">
          {t('reportSheet.reasonEyebrow')}
        </Text>
        <View className="mb-5 flex-row flex-wrap gap-2">
          {REASONS.map((r) => {
            const active = reason === r;
            return (
              <Pressable
                key={r}
                onPress={() => setReason(r)}
                className={`rounded-full border px-3 py-1.5 ${
                  active ? 'border-black bg-black' : 'border-gray-300 bg-white'
                }`}
              >
                <Text
                  className={`text-xs ${active ? 'text-white' : 'text-gray-700'}`}
                >
                  {reasonLabel(r)}
                </Text>
              </Pressable>
            );
          })}
        </View>

        <Text className="mb-2 text-[11px] uppercase tracking-[2px] text-gray-500">
          {reason === 'other'
            ? t('reportSheet.notesEyebrow.other')
            : t('reportSheet.notesEyebrow.optional')}
        </Text>
        <TextInput
          className={`mb-2 rounded-lg border px-4 py-3 text-base ${
            otherNeedsNotes ? 'border-amber-400' : 'border-gray-300'
          }`}
          placeholder={
            reason === 'other'
              ? t('reportSheet.notesPlaceholder.other')
              : t('reportSheet.notesPlaceholder.optional')
          }
          multiline
          value={notes}
          onChangeText={(next) => setNotes(next.slice(0, NOTES_MAX_LEN))}
          style={{ minHeight: 100, textAlignVertical: 'top' }}
        />
        <Text className="mb-6 text-[10px] uppercase tracking-[2px] text-gray-400">
          {t('reportSheet.notesCounter', { length: notes.length, max: NOTES_MAX_LEN })}
        </Text>

        {doneFlash ? (
          // Editorial success: typographic event, not a button-color swap.
          // Centered small-caps line + auto-close after 1.5s.
          <View className="items-center py-3">
            <Text className="text-[11px] uppercase tracking-[2px] text-forest-700">
              {t('reportSheet.successFlash')}
            </Text>
          </View>
        ) : (
          <Pressable
            onPress={handleSubmit}
            disabled={submitDisabled}
            className={`items-center rounded-lg py-3 ${
              submitDisabled ? 'bg-gray-300' : 'bg-black'
            }`}
          >
            {submit.isPending ? (
              <ActivityIndicator color="white" />
            ) : (
              // text-gray-600 on bg-gray-300 ≈ 4.5:1 (WCAG AA); the prior
              // text-gray-500 paired with the same disabled bg came out
              // ~3.4:1 — disabled controls get a relaxed standard under
              // 1.4.3 but readable beats borderline-permitted.
              <Text
                className={`text-base font-semibold ${
                  submitDisabled ? 'text-gray-600' : 'text-white'
                }`}
              >
                {t('reportSheet.submit')}
              </Text>
            )}
          </Pressable>
        )}

        <Text className="mt-4 text-[10px] uppercase tracking-[2px] text-gray-400">
          {t('reportSheet.slaHint')}
        </Text>
      </View>
    </Modal>
  );
}
