<script setup>
import { computed } from 'vue'

const props = defineProps( {
  house: { type: Object, required: true },
} )

const emit = defineEmits( [ 'blacklist' ] )

// 照片：將 400x300 換成 1000xwater2 高畫質版本（PLAN §6.2）
const photo = computed( () => {
  const url = props.house?.photo_url ?? ''
  return url ? url.replace( '400x300', '1000xwater2' ) : ''
} )

// 地址顯示文字
const addressText = computed( () =>
  `${ props.house?.section_name ?? '' } - ${ props.house?.address ?? '' }`,
)

// 591 物件詳情頁
const detailUrl = computed( () =>
  `https://sale.591.com.tw/home/house/detail/2/${ props.house?.houseid }.html`,
)

// Google 地圖搜尋連結
const mapUrl = computed( () => {
  const query = encodeURIComponent( `${ props.house?.section_name ?? '' } ${ props.house?.address ?? '' }` )
  return `https://www.google.com/maps/search/?api=1&query=${ query }`
} )

function openDetail () {
  window.open( detailUrl.value, '_blank', 'noopener' )
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
      <q-img
        :src="photo"
        class="house-card__photo"
        ratio="1.333"
        no-spinner
        loading="lazy"
      >
        <template #error>
          <div class="absolute-full flex flex-center bg-grey-9 text-grey-5">
            無照片
          </div>
        </template>
      </q-img>

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

        <div class="text-h6 text-negative text-weight-bold q-mt-sm">
          {{ house.showprice }} 萬
        </div>
      </q-card-section>
    </div>

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

  &__photo {
    width: 200px;
    min-width: 200px;
    height: 150px;
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

.ellipsis-2-lines {
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
</style>
