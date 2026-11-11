import AsyncStorage from '@react-native-async-storage/async-storage'
import { create } from 'zustand'
export const useAppearance = create<{ compact: boolean; load(): Promise<void>; toggle(): Promise<void> }>((set, get) => ({ compact: false,
  load: async () => { const value = await AsyncStorage.getItem('linkto.compact'); set({ compact: value === '1' }) },
  toggle: async () => { const compact = !get().compact; await AsyncStorage.setItem('linkto.compact', compact ? '1' : '0'); set({ compact }) }
}))
