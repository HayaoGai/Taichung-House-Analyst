<script setup>
import { computed, ref, watch } from 'vue'
import { useQuasar } from 'quasar'
import { useHouses } from 'composables/useHouses'
import HouseCard from 'components/HouseCard.vue'

const $q = useQuasar()
const {
  houses,
  isOwner,
  lastUpdatedAt,
  lastStatus,
  countdown,
  loading,
  refreshing,
  error,
  refresh,
  reload,
  blacklistHouse,
} = useHouses()

// 標記重複物件：依顯示順序，若 price/room/houseage/address 皆與前面某筆相同，
// 則該筆標記 _duplicate（前端右上角顯示 🔄）；第一筆不標記。
const decoratedHouses = computed( () => {
  const seen = new Set()
  return houses.value.map( ( h ) => {
    const key = `${ h.price }|${ h.room }|${ h.houseage }|${ h.address }`
    const duplicate = seen.has( key )
    seen.add( key )
    return { ...h, _duplicate: duplicate }
  } )
} )

// 三級行政區篩選（section_name，如「西屯區」）：單選、可取消（null 代表全部）
const selectedDistrict = ref( null )

// 選項由目前資料動態產生，附上各行政區筆數，依名稱排序
const districtOptions = computed( () => {
  const counts = new Map()
  for ( const h of houses.value ) {
    const name = h.section_name
    if ( !name ) continue
    counts.set( name, ( counts.get( name ) ?? 0 ) + 1 )
  }
  return [ ...counts.entries() ]
    .sort( ( a, b ) => a[ 0 ].localeCompare( b[ 0 ], 'zh-Hant' ) )
    .map( ( [ name, count ] ) => ( { label: `${ name } (${ count })`, value: name } ) )
} )

// 資料更新後若原選取的行政區已無物件，自動取消篩選，避免畫面空白
watch( districtOptions, ( options ) => {
  if ( selectedDistrict.value && !options.some( ( o ) => o.value === selectedDistrict.value ) ) {
    selectedDistrict.value = null
  }
} )

const filteredHouses = computed( () =>
  selectedDistrict.value
    ? decoratedHouses.value.filter( ( h ) => h.section_name === selectedDistrict.value )
    : decoratedHouses.value,
)

const lastUpdatedText = computed( () => {
  if ( !lastUpdatedAt.value ) return '尚未更新'
  const d = new Date( lastUpdatedAt.value )
  const pad = ( n ) => String( n ).padStart( 2, '0' )
  return `${ pad( d.getHours() ) }:${ pad( d.getMinutes() ) }:${ pad( d.getSeconds() ) }`
} )

// 右上角按鈕：擁有者是「手動更新」（真的觸發後端抓取），訪客是「重新載入」（只重讀 KV）。
// 兩者的差異在於成本——訪客的操作不寫 KV、不對外抓取、不推播，故可以安心公開。
async function onAction () {
  if ( isOwner.value ) {
    try {
      await refresh()
      $q.notify( { type: 'positive', message: '已更新最新物件', timeout: 1500 } )
    } catch ( e ) {
      const message = e?.message === 'FORBIDDEN'
        ? '更新權限已失效，已切換為唯讀模式'
        : '更新失敗，已保留上一份資料'
      $q.notify( { type: 'negative', message, timeout: 2500 } )
    }
    return
  }

  try {
    await reload()
    $q.notify( { type: 'positive', message: '已重新載入', timeout: 1500 } )
  } catch {
    $q.notify( { type: 'negative', message: '載入失敗，已保留上一份資料', timeout: 2500 } )
  }
}
</script>

<template>
  <q-header
    elevated
    class="bg-primary text-white"
  >
    <q-toolbar>
      <q-toolbar-title class="row items-center no-wrap">
        <q-icon name="home_work" class="q-mr-sm" />
        <span>台中待售物件監控</span>
        <q-badge
          v-if="houses.length"
          color="white"
          text-color="primary"
          class="q-ml-sm"
        >
          {{ selectedDistrict ? `${ filteredHouses.length } / ${ houses.length }` : houses.length }} 筆
        </q-badge>
      </q-toolbar-title>

      <!-- 右上角：倒數 + 手動更新 -->
      <div class="row items-center no-wrap q-gutter-sm">
        <div class="column items-end">
          <div class="text-caption" style="line-height: 1.1">
            下次更新
          </div>
          <div class="text-subtitle1 text-weight-bold countdown">
            {{ countdown }}
          </div>
        </div>
        <q-btn
          color="white"
          text-color="primary"
          :icon="isOwner ? 'refresh' : 'sync'"
          :label="isOwner ? '手動更新' : '重新載入'"
          unelevated
          :loading="refreshing"
          @click="onAction"
        >
          <q-tooltip v-if="!isOwner">
            重新讀取後端最新結果（抓取由後端每 4~6 分鐘自動執行）
          </q-tooltip>
        </q-btn>
      </div>
    </q-toolbar>
  </q-header>

  <q-page-container>
    <q-page class="q-pa-md column">
      <!-- 三級行政區篩選：單選、再點一次同一顆即取消（clearable） -->
      <div
        v-if="districtOptions.length"
        class="district-filter q-mb-md"
      >
        <q-btn-toggle
          v-model="selectedDistrict"
          :options="districtOptions"
          clearable
          spread
          no-caps
          unelevated
          :ripple="false"
          toggle-color="blue-5"
          toggle-text-color="white"
        />
      </div>

      <!-- 狀態列 -->
      <div class="row items-center justify-between q-mb-sm text-grey-7 text-caption">
        <div>
          最後更新：{{ lastUpdatedText }}
          <q-badge
            v-if="lastStatus === 'error'"
            color="warning"
            text-color="dark"
            class="q-ml-xs"
          >
            上次抓取失敗，顯示為前一份資料
          </q-badge>
        </div>

        <!-- 訪客提示：說明這是唯讀展示，垃圾桶只會隱藏在自己的瀏覽器裡 -->
        <div v-if="!isOwner">
          唯讀展示模式
          <q-icon name="info_outline" size="14px" class="q-ml-xs" />
          <q-tooltip max-width="260px">
            資料由後端每 4~6 分鐘自動抓取更新。垃圾桶按鈕只會在您自己的瀏覽器隱藏該物件，不會影響其他人。
          </q-tooltip>
        </div>
      </div>

      <!-- 初次載入 -->
      <div
        v-if="loading"
        class="col flex flex-center text-grey-6"
      >
        <q-spinner-dots size="40px" />
      </div>

      <!-- 載入錯誤且無資料 -->
      <div
        v-else-if="error && !houses.length"
        class="col flex flex-center text-negative"
      >
        無法載入資料：{{ error }}
      </div>

      <!-- 無資料 -->
      <div
        v-else-if="!houses.length"
        class="col flex flex-center text-grey-6"
      >
        目前沒有符合條件的物件
      </div>

      <!-- 篩選後無資料 -->
      <div
        v-else-if="!filteredHouses.length"
        class="col flex flex-center text-grey-6"
      >
        {{ selectedDistrict }}目前沒有物件
      </div>

      <!-- 滾動式（虛擬滾動）列表，不分頁 -->
      <q-virtual-scroll
        v-else
        :items="filteredHouses"
        :virtual-scroll-item-size="166"
        class="houses-scroll col"
      >
        <template #default="{ item }">
          <HouseCard
            :key="item.houseid"
            :house="item"
            :duplicate="item._duplicate"
            :owner="isOwner"
            class="q-mb-md"
            @blacklist="blacklistHouse"
          />
        </template>
      </q-virtual-scroll>
    </q-page>
  </q-page-container>
</template>

<style scoped lang="scss">
.countdown {
  font-variant-numeric: tabular-nums;
  line-height: 1.1;
}

// 行政區篩選列：深色分段控制器（segmented control）風格，與下方列表同寬置中
.district-filter {
  max-width: 900px;
  width: 100%;
  margin: 0 auto;

  // 外框：深灰底、圓角、細邊框；行政區較多時允許換行（overflow hidden 保住圓角）
  :deep(.q-btn-group) {
    width: 100%;
    flex-wrap: wrap;
    background: #2b2b30;
    border: 1px solid rgba(255, 255, 255, 0.08);
    border-radius: 6px;
    overflow: hidden;
    box-shadow: none;
  }

  // 未選取：透明底、淺灰字，並移除按鈕間的分隔線
  :deep(.q-btn) {
    min-height: 36px;
    padding: 0 12px;
    border: none;
    border-radius: 0;
    background: transparent;
    color: #b4b4b8;
    font-size: 13px;
    font-weight: 400;
    letter-spacing: 0;

    &::before {
      box-shadow: none;
    }

    &:hover {
      background: rgba(255, 255, 255, 0.06);
      color: #e0e0e4;
    }
  }

  // 選取中：亮藍底、白字（底色/字色由 toggle-color、toggle-text-color 提供，
  // Quasar 色彩工具類帶 !important，故此處僅補字重）
  :deep(.q-btn--active) {
    font-weight: 600;
  }
}

// 讓虛擬滾動容器吃滿剩餘高度並可內部滾動
.houses-scroll {
  max-width: 900px;
  width: 100%;
  margin: 0 auto;
  min-height: 0; // flex 子元素必須允許收縮，QVirtualScroll 才能正確虛擬化
  overflow: auto;
}
</style>
