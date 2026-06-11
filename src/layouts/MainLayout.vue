<script setup>
// 主版面：固定頂列 + 主體頁面
// 倒數與手動更新狀態由 IndexPage 透過 provide/inject 或事件處理；
// 此處為求單一資料來源，將 header 內容也放在 IndexPage，故 layout 僅留容器。
</script>

<template>
  <q-layout view="hHh lpR fFf">
    <router-view />
  </q-layout>
</template>
