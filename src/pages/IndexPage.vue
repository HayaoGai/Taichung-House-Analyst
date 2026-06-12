<script setup>
import { computed } from 'vue'
import { useQuasar } from 'quasar'
import { useHouses } from 'composables/useHouses'
import HouseCard from 'components/HouseCard.vue'

const $q = useQuasar()
const {
  houses,
  lastUpdatedAt,
  lastStatus,
  countdown,
  loading,
  refreshing,
  error,
  refresh,
  blacklistHouse,
} = useHouses()

const lastUpdatedText = computed( () => {
  if ( !lastUpdatedAt.value ) return '尚未更新'
  const d = new Date( lastUpdatedAt.value )
  const pad = ( n ) => String( n ).padStart( 2, '0' )
  return `${ pad( d.getHours() ) }:${ pad( d.getMinutes() ) }:${ pad( d.getSeconds() ) }`
} )

async function onRefresh () {
  try {
    await refresh()
    $q.notify( { type: 'positive', message: '已更新最新物件', timeout: 1500 } )
  } catch {
    $q.notify( { type: 'negative', message: '更新失敗，已保留上一份資料', timeout: 2500 } )
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
        <span>591 待售物件監控</span>
        <q-badge
          v-if="houses.length"
          color="white"
          text-color="primary"
          class="q-ml-sm"
        >
          {{ houses.length }} 筆
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
          icon="refresh"
          label="手動更新"
          unelevated
          :loading="refreshing"
          @click="onRefresh"
        />
      </div>
    </q-toolbar>
  </q-header>

  <q-page-container>
    <q-page class="q-pa-md column">
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

      <!-- 滾動式（虛擬滾動）列表，不分頁 -->
      <q-virtual-scroll
        v-else
        :items="houses"
        :virtual-scroll-item-size="166"
        class="houses-scroll col"
      >
        <template #default="{ item }">
          <HouseCard
            :key="item.houseid"
            :house="item"
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

// 讓虛擬滾動容器吃滿剩餘高度並可內部滾動
.houses-scroll {
  max-width: 900px;
  width: 100%;
  margin: 0 auto;
  min-height: 0; // flex 子元素必須允許收縮，QVirtualScroll 才能正確虛擬化
  overflow: auto;
}
</style>
