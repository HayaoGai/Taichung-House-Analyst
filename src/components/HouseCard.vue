<script setup>
import { computed, ref, watch } from 'vue'

const props = defineProps( {
  house: { type: Object, required: true },
  // 重複物件（price/room/houseage/address 與前面某筆皆相同）→ 右上角顯示 🔄
  duplicate: { type: Boolean, default: false },
} )

const emit = defineEmits( [ 'blacklist' ] )

// 照片：將 400x300 換成 1000xwater2 高畫質版本
const photo = computed( () => {
  const url = props.house?.photo_url ?? ''
  return url ? url.replace( '400x300', '1000xwater2' ) : ''
} )

// 照片載入失敗時改顯示「無照片」
const photoError = ref( false )
watch( photo, () => {
  photoError.value = false
} )

// 地址顯示文字
const addressText = computed( () =>
  `${ props.house?.section_name ?? '' } - ${ props.house?.address ?? '' }`,
)

// 591 物件詳情頁
const detailUrl = computed( () =>
  `https://sale.591.com.tw/home/house/detail/2/${ props.house?.houseid }.html`,
)

// Google 地圖規劃路線連結：起點為房屋地址，目的地為廣福樸園精緻蔬食館，交通工具為機車
const mapUrl = computed( () => {
  const target = encodeURIComponent( `${ props.house?.section_name ?? '' } ${ props.house?.address ?? '' }` )
  return `https://www.google.com.tw/maps/place/${ target }`
} )

// 實價登錄查詢連結：section_name 為三級行政區（如「西屯區」），address 為扣除縣市/行政區後的剩餘地址
const realPriceUrl = computed( () => {
  const district = encodeURIComponent( props.house?.section_name ?? '' )
  const rest = encodeURIComponent( props.house?.address ?? '' )
  return `https://price.houseprice.tw/list/台中市_city/${ district }_zip/${ rest }_kw/`
} )

// 房價分析查詢連結（以 591 詳情頁網址作為查詢參數）
const priceAnalyzeUrl = computed( () =>
  `https://buy.houseprice.tw/priceanalyze/result?url=${ detailUrl.value }`,
)

function openDetail () {
  window.open( detailUrl.value, '_blank', 'noopener' )
}

function openPriceAnalyze () {
  window.open( priceAnalyzeUrl.value, '_blank', 'noopener' )
}
</script>

<template>
  <q-card
    class="house-card cursor-pointer"
    flat
    bordered
    @click="openDetail"
  >
    <div class="row no-wrap">
      <!-- 使用原生 img（非 q-img），讓 Hover Zoom+ 等擴充套件能直接偵測到圖片 -->
      <div class="house-card__photo">
        <img
          v-if="photo && !photoError"
          :src="photo"
          :alt="house.title"
          loading="lazy"
          @error="photoError = true"
        >
        <div
          v-else
          class="house-card__photo-fallback flex flex-center bg-grey-9 text-grey-5"
        >
          無照片
        </div>
      </div>

      <q-card-section class="col house-card__body">
        <div class="text-subtitle1 text-weight-medium ellipsis-2-lines">
          {{ house.title }}
        </div>

        <div class="row items-center q-gutter-x-md q-mt-xs text-body2 text-grey-8">
          <span>{{ house.room }}</span>
          <span>{{ house.showhouseage }}</span>
          <span>{{ house.floor }}</span>
        </div>

        <div class="text-body2 text-primary q-mt-xs address-link">
          <a
            :href="mapUrl"
            target="_blank"
            rel="noopener"
            @click.stop
          >
            <q-icon name="place" size="16px" />
            {{ addressText }}
          </a>
        </div>

        <div class="row items-center q-gutter-x-sm q-mt-sm">
          <div class="text-h6 text-negative text-weight-bold">
            {{ house.showprice }} 萬
          </div>
          <span class="text-grey-8">( </span>
          <a
            :href="realPriceUrl"
            target="_blank"
            rel="noopener"
            class="text-body2 text-primary real-price-link"
            @click.stop
          >
            實價登錄
          </a>
          <span class="text-grey-8"> )</span>
        </div>
      </q-card-section>
    </div>

    <!-- 右上角：重複物件標記 🔄（price/room/houseage/address 與前面某筆皆相同） -->
    <div
      v-if="duplicate"
      class="house-card__dup"
    >
      🔄
      <q-tooltip>重複物件（與前面某筆的格局/屋齡/總價/地址皆相同）</q-tooltip>
    </div>

    <!-- 右下角：房價分析（放大鏡）。@click.stop 避免觸發整張卡片導向詳情頁 -->
    <q-btn
      class="house-card__analyze"
      icon="search"
      color="grey-6"
      flat
      round
      dense
      @click.stop="openPriceAnalyze"
    >
      <q-tooltip>房價分析</q-tooltip>
    </q-btn>

    <!-- 右下角：加入黑名單（垃圾桶）。@click.stop 避免觸發整張卡片導向詳情頁 -->
    <q-btn
      class="house-card__trash"
      icon="delete_outline"
      color="grey-6"
      flat
      round
      dense
      @click.stop="emit( 'blacklist', house )"
    >
      <q-tooltip>加入黑名單（隱藏相同格局/屋齡/總價的物件）</q-tooltip>
    </q-btn>
  </q-card>
</template>

<style scoped lang="scss">
.house-card {
  position: relative;

  &__trash {
    position: absolute;
    right: 4px;
    bottom: 4px;
    z-index: 1;
  }

  &__analyze {
    position: absolute;
    right: 40px;
    bottom: 4px;
    z-index: 1;
  }

  &__dup {
    position: absolute;
    right: 8px;
    top: 6px;
    z-index: 1;
    font-size: 18px;
    line-height: 1;
    cursor: help;
  }

  &__photo {
    width: 200px;
    min-width: 200px;
    height: 150px;

    img {
      display: block;
      width: 100%;
      height: 100%;
      object-fit: cover;
    }

    &-fallback {
      width: 100%;
      height: 100%;
    }
  }

  &__body {
    min-width: 0; // 讓 ellipsis 生效
  }
}

.address-link a {
  color: inherit;
  text-decoration: none;

  &:hover {
    text-decoration: underline;
  }
}

.real-price-link {
  text-decoration: none;

  &:hover {
    text-decoration: underline;
  }
}

.ellipsis-2-lines {
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
</style>
